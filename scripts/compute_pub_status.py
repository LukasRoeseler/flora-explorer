"""
Determine whether each FLoRA replication/reproduction's write-up was published in a
peer-reviewed journal vs. as a preprint/working paper/registry entry, based on the
journal_r field, and compare outcomes between the two groups.

Classification: a row is "preprint" if journal_r is empty/NaN, or its lowercased text
matches a known preprint-server/repository/working-paper naming pattern (OSF, arXiv,
SSRN, bioRxiv/medRxiv, or text containing "preprint", "working paper", "repository",
"registries") - a plain presence/absence test on journal_r is not enough, since
several of those venues are already recorded there as text (e.g. "OSF Registries",
"arXiv", "SSRN Electronic Journal") rather than left blank. Otherwise "journal".

Output:
  data/pub_status_data.json
  data/pub_status_meta.json
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

ROOT     = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
IN_CSV   = DATA_DIR / "flora.csv"
OUT_DATA = DATA_DIR / "pub_status_data.json"
OUT_META = DATA_DIR / "pub_status_meta.json"

if not IN_CSV.exists():
    raise SystemExit(f"{IN_CSV} not found.")

PREPRINT_KEYWORDS = [
    "osf", "arxiv", "preprint", "ssrn", "working paper",
    "repository", "registries", "biorxiv", "medrxiv",
    "psycharchiv", "zenodo",
]


def is_preprint(journal_r) -> bool:
    """True if journal_r is empty/NaN, or its lowercased text matches a known
    preprint-server/repository/working-paper naming pattern."""
    if not isinstance(journal_r, str) or not journal_r.strip():
        return True
    j = journal_r.lower()
    return any(kw in j for kw in PREPRINT_KEYWORDS)


def parse_reproduction_outcome(outcome_raw) -> tuple[str | None, str | None]:
    """Split a reproduction's compound outcome string into its two independent
    dimensions. Mirrors assets/app.js's parseReproductionOutcome() exactly so the
    frontend and this pipeline agree on how the same raw string is classified."""
    s = str(outcome_raw or "").lower()
    computational = None
    robustness = None
    for part in (p.strip() for p in s.split(",")):
        if computational is None:
            if "computational issue" in part:
                computational = "issues"
            elif "computational" in part and "success" in part:
                computational = "successful"
        if robustness is None:
            if "robustness challenge" in part:
                robustness = "challenges"
            elif "robustness not checked" in part:
                robustness = "not_checked"
            elif "robust" in part:
                robustness = "robust"
    return computational, robustness


def _clean(v):
    """Convert pandas NaN to None; JSON has no NaN literal that JS's JSON.parse accepts."""
    return None if pd.isna(v) else v


REPLICATION_OUTCOMES = ["successful", "failed", "mixed", "inconclusive"]
COMPUTATIONAL_BUCKETS = ["successful", "issues", "not_coded"]
ROBUSTNESS_BUCKETS = ["robust", "challenges", "not_checked", "not_coded"]


def compute_pub_status_result(sub: pd.DataFrame, bucket_col: str, buckets: list[str]) -> dict:
    sub = sub.copy()
    sub["is_preprint"] = sub.get("journal_r", pd.Series(dtype=str)).apply(is_preprint)

    # Every row is classifiable here (an empty journal_r counts as preprint), so
    # n_unknown is always 0 - kept in the schema for shape-parity with the other
    # analysis tabs' JSON (author_overlap_data.json, rr_status_data.json), whose
    # frontend-shared overview-box rendering expects the same field set.
    n_total = len(sub)
    n_preprint = int(sub["is_preprint"].sum())
    n_journal = n_total - n_preprint
    n_unknown = 0

    by_outcome: dict[str, dict[str, int]] = {}
    for grp, flag in [("journal", False), ("preprint", True)]:
        bkt = sub.loc[sub["is_preprint"] == flag, bucket_col]
        by_outcome[grp] = {b: int((bkt == b).sum()) for b in buckets}

    # Every row of this kind, not a subset - unlike the Registered Reports table,
    # which only lists the RR-matched studies.
    pub_studies = [
        {
            "title_r": _clean(row.get("title_r")),
            "journal_r": _clean(row.get("journal_r")),
            "year_r": _clean(row.get("year_r")),
            "outcome": _clean(row.get("outcome")),
            "doi_r": _clean(row.get("doi_r")),
            "url_r": _clean(row.get("url_r")),
            "pub_status": "preprint" if row["is_preprint"] else "journal",
        }
        for _, row in sub.iterrows()
    ]
    pub_studies.sort(key=lambda s: (s["year_r"] is None, s["year_r"]), reverse=True)

    return {
        "overview": {
            "n_total": n_total,
            "n_journal": n_journal,
            "n_preprint": n_preprint,
            "n_unknown": n_unknown,
            "pct_journal": round(100 * n_journal / n_total, 1) if n_total else 0,
            "pct_preprint": round(100 * n_preprint / n_total, 1) if n_total else 0,
        },
        "by_outcome": by_outcome,
        "pub_studies": pub_studies,
    }


# ── Load & split by study type ─────────────────────────────────────────────────
df = pd.read_csv(IN_CSV, low_memory=False, na_values=["", "NA"])
df["type_lc"] = df.get("type", pd.Series(dtype=str)).astype(str).str.lower()
df["outcome_lc"] = df.get("outcome", pd.Series(dtype=str)).astype(str).str.lower().str.strip()

is_reproduction = df["type_lc"].str.contains("reproduc", na=False)
is_replication = df["type_lc"].str.contains("replication", na=False) & ~is_reproduction

repro_df = df[is_reproduction].copy()
repro_dims = repro_df["outcome_lc"].apply(parse_reproduction_outcome)
repro_df["computational_bucket"] = repro_dims.apply(lambda t: t[0] or "not_coded")
repro_df["robustness_bucket"] = repro_dims.apply(lambda t: t[1] or "not_coded")

result = {
    "replication": compute_pub_status_result(df[is_replication], "outcome_lc", REPLICATION_OUTCOMES),
    "reproduction-numerical": compute_pub_status_result(repro_df, "computational_bucket", COMPUTATIONAL_BUCKETS),
    "reproduction-robustness": compute_pub_status_result(repro_df, "robustness_bucket", ROBUSTNESS_BUCKETS),
}

OUT_DATA.write_text(json.dumps(result), encoding="utf-8")
OUT_META.write_text(json.dumps({
    "last_updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "n_total": {k: v["overview"]["n_total"] for k, v in result.items()},
    "source": "scripts/compute_pub_status.py",
}, indent=2), encoding="utf-8")

for kind, r in result.items():
    ov = r["overview"]
    print(f"{kind}: n_total={ov['n_total']}, journal={ov['n_journal']} ({ov['pct_journal']}%), "
          f"preprint={ov['n_preprint']} ({ov['pct_preprint']}%)")
print(f"Written: {OUT_DATA}")
