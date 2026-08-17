"""
Enrich the FLoRA dataset with the OpenAlex "Mean Citedness" (OMC) of each
original study's journal.

Produces data/flora_with_omc.csv with the columns of flora.csv plus:
  - openalex_venue_id   (string, may be empty if no match)
  - openalex_venue_name (string)
  - impact_factor       (float, the "summary_stats.2yr_mean_citedness")

The OMC value is what feeds the Mean Citedness analysis rendered by R.

OpenAlex is free and does not require an API key, but it asks for a contact
email in the User-Agent string. Set MY_EMAIL via repo secrets to be polite.

Designed for GitHub Actions with a per-run time budget and on-disk caching of
venue lookups (cache/openalex_venues.json) so weekly runs are fast.
"""
from __future__ import annotations

import csv
import json
import os
import re
import time
from datetime import datetime, timezone
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
CACHE_DIR = ROOT / "cache"
DATA_DIR.mkdir(exist_ok=True)
CACHE_DIR.mkdir(exist_ok=True)

IN_CSV = DATA_DIR / "flora.csv"
OUT_CSV = DATA_DIR / "flora_with_omc.csv"
CACHE_FILE = CACHE_DIR / "openalex_venues.json"

EMAIL = os.environ.get("MY_EMAIL", "").strip() or "noreply@example.org"
SESSION = requests.Session()
SESSION.headers.update({"User-Agent": f"FLoRA-Explorer/1.0 (mailto:{EMAIL})"})

OPENALEX_SOURCES = "https://api.openalex.org/sources"
BASE_DELAY = 0.12  # OpenAlex allows ~10 req/s with mailto


def normalize_name(name: str) -> str:
    if not name:
        return ""
    s = name.lower().strip()
    s = re.sub(r"\s+", " ", s)
    s = re.sub(r"[^\w\s&:,.\-/]", "", s)
    return s


def load_cache() -> dict:
    if CACHE_FILE.exists():
        try:
            return json.loads(CACHE_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {}


def save_cache(cache: dict) -> None:
    CACHE_FILE.write_text(json.dumps(cache, indent=2), encoding="utf-8")


def lookup_venue(name: str, cache: dict) -> dict | None:
    """Resolve a journal name to an OpenAlex Source with summary_stats."""
    key = normalize_name(name)
    if not key:
        return None
    if key in cache:
        return cache[key]

    # Fuzzy search on display_name, restricted to journal-like sources.
    params = {
        "search": name,
        "per-page": "1",
        "filter": "type:journal|conference|repository|ebook platform",
        "mailto": EMAIL,
    }
    try:
        r = SESSION.get(OPENALEX_SOURCES, params=params, timeout=30)
    except requests.exceptions.RequestException as e:
        print(f"  ! network error for {name[:60]}: {e}")
        return None

    if r.status_code == 429:
        time.sleep(2.0)
        try:
            r = SESSION.get(OPENALEX_SOURCES, params=params, timeout=30)
        except requests.exceptions.RequestException:
            return None

    if r.status_code != 200:
        print(f"  ! HTTP {r.status_code} for {name[:60]}")
        cache[key] = None
        return None

    try:
        results = r.json().get("results", [])
    except ValueError:
        cache[key] = None
        return None

    if not results:
        cache[key] = None
        return None

    src = results[0]
    summary = (src.get("summary_stats") or {})
    omc = summary.get("2yr_mean_citedness")
    entry = {
        "id": src.get("id"),
        "display_name": src.get("display_name"),
        "impact_factor": float(omc) if omc is not None else None,
    }
    cache[key] = entry
    time.sleep(BASE_DELAY)
    return entry


def load_disciplines() -> dict:
    """journal name (lowercase, trimmed) -> discipline, from data/disciplines.json's
    {discipline: [journal, ...]} shape."""
    path = DATA_DIR / "disciplines.json"
    if not path.exists():
        return {}
    data = json.loads(path.read_text(encoding="utf-8"))
    mapping = {}
    for discipline, journals in data.items():
        for j in journals:
            mapping[str(j).strip().lower()] = discipline
    return mapping


def parse_reproduction_outcome(outcome_raw) -> tuple[str | None, str | None]:
    """Split a reproduction's compound outcome string into its two independent
    dimensions. Mirrors assets/app.js's parseReproductionOutcome() exactly - always a
    "computational, robustness" two-part comma-joined string, parsed positionally (part
    0 only tested against computational keywords, part 1 only against robustness
    keywords) so the two dimensions' text never cross-contaminate. Covers both the
    legacy vocabulary ("computationally successful, robust") and the current one from
    FReD-data's two-axis reproductions spreadsheet ("computationally reproducible" /
    "computational issues" / "technical failure" / "failed" / "not checked" for the
    computational dimension; "robust" / "robustness challenges" / "not checked" for
    robustness)."""
    parts = [p.strip() for p in str(outcome_raw or "").lower().split(",")]
    p0 = parts[0] if len(parts) > 0 else ""
    p1 = parts[1] if len(parts) > 1 else ""
    computational = None
    robustness = None

    if "technical failure" in p0 or p0 == "failed":
        computational = "technical_failure"
    elif "computational issue" in p0:
        computational = "issues"
    elif "computationally reproducible" in p0 or ("computational" in p0 and "success" in p0):
        computational = "successful"
    elif "not checked" in p0:
        computational = "not_checked"

    if "robustness challenge" in p1:
        robustness = "challenges"
    elif "not checked" in p1:
        robustness = "not_checked"
    elif "robust" in p1:
        robustness = "robust"

    return computational, robustness


def compute_reproduction_impact_stats(rows: list[dict]) -> None:
    """Mean-Citedness stats for reproduction rows, split by computational/robustness
    dimension. Written separately from data/impact_factor_data.json (which
    render_impact_factor.R produces for replications) so this Python-only addition
    can't affect that existing, working R pipeline. Deliberately skips GAM smoothing:
    render_impact_factor.R already requires n >= 30 for its replication GAM, and
    reproductions - currently under 20 rows total - never approach that."""
    discipline_map = load_disciplines()
    repro_rows = []
    for row in rows:
        if "reproduc" not in (row.get("type") or "").lower():
            continue
        try:
            impact = float(row.get("impact_factor") or "")
        except ValueError:
            impact = None
        if impact is None or impact >= 35:
            continue
        computational, robustness = parse_reproduction_outcome(row.get("outcome"))
        journal = (row.get("journal_o") or "").strip()
        repro_rows.append({
            "impact_factor": impact,
            "journal": journal,
            "discipline": discipline_map.get(journal.lower(), "Uncategorized"),
            "computational": computational or "not_coded",
            "robustness": robustness or "not_coded",
        })

    def build_dimension(bucket_key: str, buckets: list[str]) -> dict:
        journals = {r["journal"] for r in repro_rows if r["journal"]}
        disciplines = {r["discipline"] for r in repro_rows if r["discipline"] != "Uncategorized"}
        overview = {"n_total": len(repro_rows), "n_journals": len(journals), "n_disciplines": len(disciplines)}
        for b in buckets:
            overview[f"n_{b}"] = sum(1 for r in repro_rows if r[bucket_key] == b)

        breaks = [i * 0.5 for i in range(41)]  # 0..20 in steps of 0.5, matching the R histogram
        histogram = []
        for lo, hi in zip(breaks[:-1], breaks[1:]):
            counts = {b: 0 for b in buckets}
            for r in repro_rows:
                if lo <= r["impact_factor"] < hi:
                    counts[r[bucket_key]] += 1
            histogram.append({"bin_lo": lo, "bin_hi": hi, **counts})

        return {
            "overview": overview,
            "histogram": histogram,
            "stats": {"edf": None, "chi_sq": None, "p_val": None, "r2": None, "n_model": 0},
            "gam_curve": [],
            "jitter": [],
        }

    result = {
        "reproduction-numerical": build_dimension("computational", ["successful", "issues", "technical_failure", "not_checked", "not_coded"]),
        "reproduction-robustness": build_dimension("robustness", ["robust", "challenges", "not_checked", "not_coded"]),
    }
    out_path = DATA_DIR / "impact_factor_reproductions.json"
    out_path.write_text(json.dumps(result), encoding="utf-8")
    print(f"✔ Wrote {out_path.relative_to(ROOT)} "
          f"(numerical n={result['reproduction-numerical']['overview']['n_total']}, "
          f"robustness n={result['reproduction-robustness']['overview']['n_total']})")


def main():
    if not IN_CSV.exists():
        raise SystemExit(f"{IN_CSV} not found. Run refresh_flora.py first.")

    cache = load_cache()

    with IN_CSV.open(encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        rows = list(reader)
        base_columns = reader.fieldnames or []

    extra_cols = ["openalex_venue_id", "openalex_venue_name", "impact_factor"]
    out_columns = list(base_columns) + [c for c in extra_cols if c not in base_columns]

    unique_journals = sorted({(r.get("journal_o") or "").strip() for r in rows if (r.get("journal_o") or "").strip()})
    print(f"{len(unique_journals)} unique journals to resolve "
          f"(cache has {len(cache)} entries)")

    new_lookups = 0
    for i, j in enumerate(unique_journals, 1):
        if normalize_name(j) in cache:
            continue
        lookup_venue(j, cache)
        new_lookups += 1
        if new_lookups % 50 == 0:
            save_cache(cache)
            print(f"  resolved {new_lookups} new journals ({i}/{len(unique_journals)})")

    save_cache(cache)
    print(f"✔ {new_lookups} new venues looked up; cache size now {len(cache)}")

    enriched = 0
    for row in rows:
        j = (row.get("journal_o") or "").strip()
        entry = cache.get(normalize_name(j)) if j else None
        row["openalex_venue_id"] = (entry or {}).get("id", "") if entry else ""
        row["openalex_venue_name"] = (entry or {}).get("display_name", "") if entry else ""
        if_val = (entry or {}).get("impact_factor") if entry else None
        row["impact_factor"] = "" if if_val is None else f"{if_val:.4f}"
        if if_val is not None:
            enriched += 1

    with OUT_CSV.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=out_columns)
        writer.writeheader()
        writer.writerows(rows)

    meta = {
        "last_updated": datetime.now(timezone.utc).isoformat(),
        "n_rows": len(rows),
        "n_with_omc": enriched,
        "source": "OpenAlex Sources API (summary_stats.2yr_mean_citedness)",
    }
    (DATA_DIR / "flora_with_omc_meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    print(f"✔ Wrote {OUT_CSV.relative_to(ROOT)} ({enriched}/{len(rows)} rows have OMC)")

    compute_reproduction_impact_stats(rows)


if __name__ == "__main__":
    main()
