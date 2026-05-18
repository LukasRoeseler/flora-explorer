"""
FLoRA × OpenCitations pipeline for the public Citation Impact Explorer.

Optimised for GitHub Actions:
- Uses FLoRA's own metadata (no OC metadata calls)
- Time-budgeted (exits cleanly before workflow timeout)
- Resumes from disk cache (committed between runs)
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
import requests
import statsmodels.api as sm
from tqdm import tqdm

# ------------------------------------------------------------------ config
ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
CACHE_DIR = ROOT / "cache"
DATA_DIR.mkdir(exist_ok=True)
CACHE_DIR.mkdir(exist_ok=True)

FLORA_URL = "https://raw.githubusercontent.com/forrtproject/FReD-data/main/output/flora.csv"
OC_BASE = "https://opencitations.net/index/api/v2"
OC_KEY = os.environ.get("OC_API_KEY", "").strip()
EMAIL = os.environ.get("MY_EMAIL", "").strip()

CACHE_TTL_DAYS = 30
CURRENT_YEAR = datetime.now(timezone.utc).year
EVENT_WINDOW = (-10, 10)

MAX_RUNTIME_SECONDS = int(os.environ.get("MAX_RUNTIME_SECONDS", 5 * 3600))
START_TIME = time.time()

BASE_DELAY = 0.7
OUTCOMES_KEEP = {"successful", "failed", "mixed"}

session = requests.Session()
session.headers.update({"User-Agent": f"FLoRA-Explorer/1.0 ({EMAIL})"})
if OC_KEY:
    session.headers.update({"authorization": OC_KEY})


# ------------------------------------------------------------------ helpers
def time_left() -> float:
    return MAX_RUNTIME_SECONDS - (time.time() - START_TIME)


def should_stop(reserve_seconds: int = 600) -> bool:
    return time_left() < reserve_seconds


def doi_clean(s) -> str | None:
    if not isinstance(s, str):
        return None
    s = s.strip().lower()
    s = re.sub(r"^https?://(dx\.)?doi\.org/", "", s)
    s = re.sub(r"^doi:\s*", "", s)
    return s if s and s != "nan" else None


def doi_slug(doi: str) -> str:
    return hashlib.sha1(doi.encode()).hexdigest()[:16]


def cache_path(kind: str, doi: str) -> Path:
    return CACHE_DIR / kind / f"{doi_slug(doi)}.json"


def cache_fresh(p: Path) -> bool:
    if not p.exists():
        return False
    age_days = (time.time() - p.stat().st_mtime) / 86400
    return age_days < CACHE_TTL_DAYS


def parse_year(s) -> int | None:
    if s is None or (isinstance(s, float) and np.isnan(s)):
        return None
    m = re.search(r"\b(19|20)\d{2}\b", str(s))
    return int(m.group(0)) if m else None

import json as _json

def parse_flora_authors(raw, max_n: int = 6) -> str:
    """Parse FLoRA author field (JSON-like) into a clean 'Family, G.; ...' string."""
    if raw is None or (isinstance(raw, float) and np.isnan(raw)):
        return ""
    s = str(raw).strip()
    if not s:
        return ""
    if not (s.startswith("[") or '"family"' in s or "'family'" in s):
        return s[:200]
    parsed = None
    try:
        parsed = _json.loads(s.replace("'", '"'))
    except Exception:
        # Regex fallback for malformed strings
        pairs = re.findall(
            r'"given"\s*:\s*"([^"]*)"[^}]*?"family"\s*:\s*"([^"]*)"'
            r'|"family"\s*:\s*"([^"]*)"[^}]*?"given"\s*:\s*"([^"]*)"'
            r'|"family"\s*:\s*"([^"]*)"',
            s,
        )
        parsed = []
        for g1, f1, f2, g2, f3 in pairs:
            parsed.append({"given": g1 or g2, "family": f1 or f2 or f3})

    if not isinstance(parsed, list):
        return s[:200]

    names = []
    for a in parsed:
        if not isinstance(a, dict):
            continue
        family = (a.get("family") or a.get("last") or "").strip()
        given = (a.get("given") or a.get("first") or "").strip()
        if not family:
            continue
        initials = " ".join(
            p[0].upper() + "." for p in given.split() if p
        ).strip()
        names.append(f"{family}, {initials}" if initials else family)

    if not names:
        return s[:200]
    if len(names) <= max_n:
        return "; ".join(names)
    return "; ".join(names[:max_n]) + f", … (+{len(names)-max_n})"

def clean_for_json(obj):
    """Recursively convert NaN / numpy types to JSON-safe values."""
    if isinstance(obj, dict):
        return {k: clean_for_json(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [clean_for_json(v) for v in obj]
    if isinstance(obj, float):
        if np.isnan(obj) or np.isinf(obj):
            return None
        return obj
    if isinstance(obj, np.floating):
        f = float(obj)
        return None if (np.isnan(f) or np.isinf(f)) else f
    if isinstance(obj, np.integer):
        return int(obj)
    if isinstance(obj, np.ndarray):
        return clean_for_json(obj.tolist())
    try:
        if pd.isna(obj):
            return None
    except (TypeError, ValueError):
        pass
    return obj


# ------------------------------------------------------------------ FLoRA
def load_flora() -> pd.DataFrame:
    print("Fetching FLoRA…")
    df = pd.read_csv(FLORA_URL, low_memory=False)
    print(f"  {len(df)} rows; columns: {list(df.columns)[:14]}…")

    def find_col(names, required=True, default=None):
        for n in names:
            for c in df.columns:
                if c.lower() == n.lower():
                    return c
        if required:
            raise KeyError(f"None of {names} found in FLoRA columns")
        return default

    col_doi_o   = find_col(["doi_o"])
    col_doi_r   = find_col(["doi_r"])
    col_outcome = find_col(["result", "outcome", "result_class"], required=False)
    col_type    = find_col(["type", "study_type", "ref_type"], required=False)

    col_title_o = find_col(["title_o", "ref_o"], required=False)
    col_auth_o  = find_col(["author_o"], required=False)
    col_year_o  = find_col(["year_o"], required=False)
    col_journal_o = find_col(["journal_o"], required=False)

    col_title_r = find_col(["title_r", "ref_r"], required=False)
    col_auth_r  = find_col(["author_r"], required=False)
    col_year_r  = find_col(["year_r"], required=False)

    out = pd.DataFrame({
        "doi_o":     df[col_doi_o].map(doi_clean),
        "doi_r":     df[col_doi_r].map(doi_clean),
        "outcome":   df[col_outcome].astype(str).str.lower().str.strip() if col_outcome else "unknown",
        "type":      df[col_type].astype(str).str.lower().str.strip() if col_type else "replication",
        "title_o":   df[col_title_o] if col_title_o else "",
        "author_o":  df[col_auth_o] if col_auth_o else "",
        "year_o":    df[col_year_o] if col_year_o else None,
        "journal_o": df[col_journal_o] if col_journal_o else "",
        "title_r":   df[col_title_r] if col_title_r else "",
        "author_r":  df[col_auth_r] if col_auth_r else "",
        "year_r":    df[col_year_r] if col_year_r else None,
    })

    n0 = len(out)
    out = out[out["type"].str.contains("replication", na=False)
              & ~out["type"].str.contains("reproduc", na=False)]
    out = out[out["outcome"].isin(OUTCOMES_KEEP)]
    out = out.dropna(subset=["doi_o", "doi_r"]).drop_duplicates(subset=["doi_o", "doi_r"])
    print(f"  Filtered: {n0} → {len(out)} (replications with known outcomes)")
    return out.reset_index(drop=True)


# ------------------------------------------------------------------ OpenCitations
def fetch_oc_citations(doi: str) -> list[dict] | None:
    cp = cache_path("oc", doi)
    if cache_fresh(cp):
        try:
            return json.loads(cp.read_text())
        except Exception:
            pass

    cp.parent.mkdir(exist_ok=True)
    url = f"{OC_BASE}/citations/doi:{doi}"

    for attempt in (1, 2):
        try:
            r = session.get(url, timeout=45)
        except requests.exceptions.RequestException as e:
            print(f"  ! network error {doi[:40]}: {e}")
            return None

        if r.status_code == 200:
            try:
                rows = r.json()
            except Exception:
                rows = []
            out = []
            for row in rows:
                citing = doi_clean(str(row.get("citing", "")).replace("doi:", ""))
                creation = row.get("creation", "")
                year = None
                if creation and len(creation) >= 4 and creation[:4].isdigit():
                    year = int(creation[:4])
                if citing and year:
                    out.append({"citing": citing, "year": year})
            cp.write_text(json.dumps(out))
            time.sleep(BASE_DELAY)
            return out

        if r.status_code == 404:
            cp.write_text("[]")
            time.sleep(BASE_DELAY)
            return []

        if r.status_code == 429:
            if attempt == 1:
                time.sleep(8)
                continue
            else:
                print(f"  · skip {doi[:40]} (persistent 429)")
                return None

        print(f"  ! HTTP {r.status_code} for {doi[:40]}")
        return None

    return None


# ------------------------------------------------------------------ build per-study panel
def build_study_data(flora: pd.DataFrame) -> dict:
    studies = {}
    originals = sorted(flora["doi_o"].unique())
    print(f"Fetching citations for {len(originals)} originals…")

    meta_o_by_doi = (
        flora.groupby("doi_o")
        .agg(title=("title_o", "first"),
             author=("author_o", "first"),
             year=("year_o", "first"),
             venue=("journal_o", "first"))
        .to_dict("index")
    )

    n_skipped = 0

    for doi_o in tqdm(originals):
        if should_stop():
            print(f"⏰ Time budget exhausted; stopping at {len(studies)} originals.")
            break

        meta_o = meta_o_by_doi.get(doi_o, {})
        cites_o = fetch_oc_citations(doi_o)
        if cites_o is None:
            n_skipped += 1
            continue

        reps_df = flora[flora["doi_o"] == doi_o][
            ["doi_r", "outcome", "title_r", "author_r", "year_r"]
        ].drop_duplicates(subset=["doi_r"])

        rep_info = []
        rep_citings_by_outcome = {"successful": set(), "failed": set(), "mixed": set()}

        for _, row in reps_df.iterrows():
            if should_stop():
                break
            doi_r = row["doi_r"]
            cites_r = fetch_oc_citations(doi_r)
            if cites_r is None:
                cites_r = []
            year_r = parse_year(row["year_r"])
            rep_info.append({
                "doi": doi_r,
                "year": year_r,
                "outcome": row["outcome"],
                "title": str(row["title_r"])[:300] if pd.notna(row["title_r"]) else "",
                "author": parse_flora_authors(row["author_r"]),
            })
            for c in cites_r:
                rep_citings_by_outcome[row["outcome"]].add(c["citing"])

        per_year = {}
        for c in cites_o:
            y = c["year"]; citing = c["citing"]
            bucket = per_year.setdefault(y, {
                "only": 0, "with_successful": 0, "with_failed": 0, "with_mixed": 0
            })
            cocited = {o for o, s in rep_citings_by_outcome.items() if citing in s}
            if not cocited:
                bucket["only"] += 1
            else:
                if "successful" in cocited: bucket["with_successful"] += 1
                if "failed" in cocited:     bucket["with_failed"] += 1
                if "mixed" in cocited:      bucket["with_mixed"] += 1

        timeline = sorted([{"year": y, **v} for y, v in per_year.items()],
                          key=lambda x: x["year"])

        rep_years = [r["year"] for r in rep_info if r["year"]]
        treat_year = min(rep_years) if rep_years else None

        first_outcome = None
        if rep_info:
            sorted_reps = sorted(
                rep_info, key=lambda r: (r["year"] is None, r["year"] or 9999)
            )
            first_outcome = sorted_reps[0]["outcome"]

        year_o = parse_year(meta_o.get("year"))
        title = str(meta_o.get("title") or "")[:300]
        author = parse_flora_authors(meta_o.get("author"))
        venue = str(meta_o.get("venue") or "")[:200]

        outcome_mix = dict(reps_df["outcome"].value_counts())
        outcome_mix = {k: int(v) for k, v in outcome_mix.items()}

        studies[doi_o] = {
            "doi": doi_o,
            "title": title,
            "author": author,
            "year": year_o,
            "venue": venue,
            "n_citations": len(cites_o),
            "replications": rep_info,
            "n_replications": len(rep_info),
            "outcome_mix": outcome_mix,
            "first_replication_year": treat_year,
            "first_replication_outcome": first_outcome,
            "timeline": timeline,
        }

    if n_skipped:
        print(f"  ({n_skipped} originals skipped due to API issues; will retry next run)")
    return studies


# ------------------------------------------------------------------ aggregate event-study
def build_panel(studies: dict) -> pd.DataFrame:
    rows = []
    for doi, s in studies.items():
        if s["year"] is None:
            continue
        y_min = s["year"]; y_max = CURRENT_YEAR
        cite_by_year = {t["year"]: sum(t[k] for k in
                                       ("only","with_successful","with_failed","with_mixed"))
                        for t in s["timeline"]}
        cocite_by_year = {t["year"]: t["with_successful"] + t["with_failed"] + t["with_mixed"]
                          for t in s["timeline"]}
        for y in range(y_min, y_max + 1):
            rows.append({
                "doi": doi, "year": y, "age": y - s["year"],
                "n_cit": cite_by_year.get(y, 0),
                "n_cocit": cocite_by_year.get(y, 0),
                "treat_year": s["first_replication_year"],
                "outcome": s["first_replication_outcome"],
            })
    if not rows:
        return pd.DataFrame(columns=["doi","year","age","n_cit","n_cocit",
                                      "treat_year","outcome","event_time","post"])
    panel = pd.DataFrame(rows)
    panel["event_time"] = panel["year"] - panel["treat_year"]
    panel["post"] = (panel["event_time"] >= 0).astype(int)
    return panel


def event_study(panel: pd.DataFrame, outcomes: list[str], depvar: str) -> dict:
    """
    Event-study with study + year fixed effects via manual two-way demeaning.
    Outcome is log(1+y); coefficients are interpreted as approx. log effects.
    Robust to thousands of units.
    """
    empty = {"event_time": [], "estimate": [], "ci_low": [], "ci_high": [],
             "att": None, "att_ci": None, "n_units": 0}
    if panel.empty or "outcome" not in panel.columns:
        return empty

    p = panel[panel["outcome"].isin(outcomes) & panel["treat_year"].notna()].copy()
    if p.empty:
        return empty

    lo, hi = EVENT_WINDOW
    p = p[p["event_time"].between(lo, hi)].copy()
    if p.empty or p["doi"].nunique() < 5:
        return empty | {"n_units": int(p["doi"].nunique())}

    p["y"] = np.log1p(p[depvar].astype(float))

    dummies = pd.get_dummies(p["event_time"].astype(int), prefix="et", drop_first=False)
    if "et_-1" in dummies.columns:
        dummies = dummies.drop(columns=["et_-1"])

    work_cols = ["y"] + list(dummies.columns)
    work = pd.concat([
        p[["doi", "year", "y"]].reset_index(drop=True),
        dummies.reset_index(drop=True).astype(float),
    ], axis=1)

    # Iterative two-way within transformation
    try:
        for _ in range(20):
            for grp in ["doi", "year"]:
                work[work_cols] = work[work_cols] - work.groupby(grp)[work_cols].transform("mean")
    except Exception as e:
        print(f"  ! demean fail ({outcomes}, {depvar}): {e}")
        return empty | {"n_units": int(p["doi"].nunique())}

    X = work[list(dummies.columns)].values
    y = work["y"].values
    try:
        ols = sm.OLS(y, X).fit(cov_type="cluster",
                                cov_kwds={"groups": p["doi"].values})
    except Exception as e:
        print(f"  ! event_study OLS fail ({outcomes}, {depvar}): {e}")
        return empty | {"n_units": int(p["doi"].nunique())}

    coef = dict(zip(dummies.columns, ols.params))
    se = dict(zip(dummies.columns, ols.bse))

    rows = []
    for t in range(lo, hi + 1):
        if t == -1:
            rows.append({"event_time": t, "estimate": 0.0, "ci_low": 0.0, "ci_high": 0.0})
            continue
        key = f"et_{t}"
        if key not in coef:
            continue
        b = float(coef[key]); s = float(se[key])
        rows.append({"event_time": t, "estimate": b,
                     "ci_low": b - 1.96 * s, "ci_high": b + 1.96 * s})

    post = [r for r in rows if r["event_time"] >= 0]
    att = float(np.mean([r["estimate"] for r in post])) if post else None
    att_ci = None
    if post:
        ses = [(r["ci_high"] - r["estimate"]) / 1.96 for r in post]
        avg_se = float(np.sqrt(np.mean(np.square(ses))) / np.sqrt(len(post)))
        att_ci = [att - 1.96 * avg_se, att + 1.96 * avg_se]

    return {
        "event_time": [r["event_time"] for r in rows],
        "estimate":   [r["estimate"]   for r in rows],
        "ci_low":     [r["ci_low"]     for r in rows],
        "ci_high":    [r["ci_high"]    for r in rows],
        "att": att, "att_ci": att_ci,
        "n_units": int(p["doi"].nunique()),
    }


def descriptive_trajectory(panel: pd.DataFrame, outcomes: list[str]) -> dict:
    if panel.empty or "outcome" not in panel.columns:
        return {"event_time": [], "mean_citations": [], "mean_cocitations": [], "n_units": []}
    p = panel[panel["outcome"].isin(outcomes) & panel["treat_year"].notna()]
    lo, hi = EVENT_WINDOW
    p = p[p["event_time"].between(lo, hi)]
    if p.empty:
        return {"event_time": [], "mean_citations": [], "mean_cocitations": [], "n_units": []}
    g = p.groupby("event_time").agg(
        cites=("n_cit", "mean"),
        cocites=("n_cocit", "mean"),
        n=("doi", "nunique"),
    ).reset_index()
    return {
        "event_time":      g["event_time"].tolist(),
        "mean_citations":  g["cites"].round(3).tolist(),
        "mean_cocitations":g["cocites"].round(3).tolist(),
        "n_units":         g["n"].tolist(),
    }


def write_outputs(studies: dict, flora: pd.DataFrame, partial: bool = False):
    panel = build_panel(studies)
    aggregate = {}
    for label, outcomes in [
        ("all", ["successful", "failed", "mixed"]),
        ("failed", ["failed"]),
        ("successful", ["successful"]),
        ("mixed", ["mixed"]),
    ]:
        aggregate[label] = {
            "descriptive":       descriptive_trajectory(panel, outcomes),
            "citations_model":   event_study(panel, outcomes, "n_cit"),
            "cocitations_model": event_study(panel, outcomes, "n_cocit"),
        }

    originals_index = []
    for doi, s in studies.items():
        originals_index.append({
            "doi": doi,
            "title": s["title"], "author": s["author"], "year": s["year"],
            "venue": s["venue"],
            "n_citations": s["n_citations"], "n_replications": s["n_replications"],
            "outcome_mix": s["outcome_mix"],
            "first_replication_year": s["first_replication_year"],
            "first_replication_outcome": s["first_replication_outcome"],
        })

    meta = {
        "last_updated": datetime.now(timezone.utc).isoformat(),
        "n_originals": len(studies),
        "n_replications": int(flora.shape[0]),
        "outcome_counts": {k: int(v) for k, v in flora["outcome"].value_counts().items()},
        "partial_run": partial,
    }
    (DATA_DIR / "meta.json").write_text(
        json.dumps(clean_for_json(meta), indent=2, allow_nan=False))
    (DATA_DIR / "originals.json").write_text(
        json.dumps(clean_for_json({"studies": studies, "index": originals_index}),
                   allow_nan=False))
    (DATA_DIR / "aggregate.json").write_text(
        json.dumps(clean_for_json(aggregate), indent=2, allow_nan=False))
    print(f"✔ wrote {len(studies)} studies "
          f"({'partial' if partial else 'complete'} run)")


# ------------------------------------------------------------------ main
def main():
    flora = load_flora()
    studies = {}
    partial = True
    try:
        studies = build_study_data(flora)
        partial = should_stop()
    except KeyboardInterrupt:
        print("⛔ interrupted")
    finally:
        write_outputs(studies, flora, partial=partial)
    print(f"Done. {len(studies)} originals processed.")


if __name__ == "__main__":
    main()
