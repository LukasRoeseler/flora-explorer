"""
Compute author overlap between original and replication studies.

For each replication, checks whether any author family name from the
original study also appears in the replication's author list.
Family names are normalised (lowercase, diacritics stripped) before
comparison to reduce false negatives.  False positives remain possible
for common family names — this is noted in the dashboard.

Output:
  data/author_overlap_data.json
  data/author_overlap_meta.json
"""
from __future__ import annotations

import json
import re
import unicodedata
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

ROOT     = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
IN_CSV   = DATA_DIR / "flora.csv"
OUT_DATA = DATA_DIR / "author_overlap_data.json"
OUT_META = DATA_DIR / "author_overlap_meta.json"

if not IN_CSV.exists():
    raise SystemExit(f"{IN_CSV} not found.")


def normalize(name: str) -> str:
    """Lowercase, strip diacritics, keep only letters."""
    name = unicodedata.normalize("NFD", name)
    name = "".join(c for c in name if unicodedata.category(c) != "Mn")
    return re.sub(r"[^a-z]", "", name.lower())


def family_names(author_json) -> set[str]:
    """Extract normalised family names from an author JSON string."""
    if not isinstance(author_json, str) or not author_json.strip():
        return set()
    # Structured JSON path
    try:
        entries = json.loads(author_json)
        if isinstance(entries, list):
            names = {normalize(a["family"]) for a in entries
                     if isinstance(a, dict) and a.get("family")}
            return {n for n in names if len(n) > 1}
    except Exception:
        pass
    # Regex fallback for malformed JSON
    raw = re.findall(r'"family"\s*:\s*"([^"]+)"', author_json)
    return {normalize(n) for n in raw if len(normalize(n)) > 1}


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


# ── Compute per-row overlap flag ───────────────────────────────────────────────
def _overlap(row) -> bool | None:
    orig = family_names(row.get("author_o", ""))
    repl = family_names(row.get("author_r", ""))
    if not orig or not repl:
        return None
    return bool(orig & repl)


REPLICATION_OUTCOMES = ["successful", "failed", "mixed", "inconclusive"]
COMPUTATIONAL_BUCKETS = ["successful", "issues", "technical_failure", "not_checked", "not_coded"]
ROBUSTNESS_BUCKETS = ["robust", "challenges", "not_checked", "not_coded"]
MIN_N_FOR_BREAKDOWN = 5  # below this, a per-bucket overlap breakdown is not meaningful


def compute_overlap_result(sub: pd.DataFrame, bucket_fn, buckets: list[str]) -> dict:
    """Shared overlap computation for one study-type slice of the data. bucket_fn maps a
    row's outcome to one of `buckets` (replication: fixed 4-outcome vocabulary; reproduction:
    the parsed computational or robustness dimension)."""
    sub = sub.copy()
    sub["author_overlap"] = sub.apply(_overlap, axis=1)
    sub["bucket"] = sub.apply(bucket_fn, axis=1)

    known = sub[sub["author_overlap"].notna()].copy()
    n_total = len(known)
    n_overlap = int(known["author_overlap"].sum())
    n_no_overlap = n_total - n_overlap
    n_unknown = int(sub["author_overlap"].isna().sum())

    by_outcome: dict[str, dict[str, int]] = {}
    for grp, flag in [("overlap", True), ("no_overlap", False)]:
        bkt = known.loc[known["author_overlap"] == flag, "bucket"]
        by_outcome[grp] = {b: int((bkt == b).sum()) for b in buckets}

    return {
        "overview": {
            "n_total": n_total,
            "n_overlap": n_overlap,
            "n_no_overlap": n_no_overlap,
            "n_unknown": n_unknown,
            "pct_overlap": round(100 * n_overlap / n_total, 1) if n_total else 0,
            "pct_no_overlap": round(100 * n_no_overlap / n_total, 1) if n_total else 0,
            "insufficient_n": n_total < MIN_N_FOR_BREAKDOWN,
        },
        "by_outcome": by_outcome,
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
    "replication": compute_overlap_result(
        df[is_replication], lambda r: r["outcome_lc"], REPLICATION_OUTCOMES
    ),
    "reproduction-numerical": compute_overlap_result(
        repro_df, lambda r: r["computational_bucket"], COMPUTATIONAL_BUCKETS
    ),
    "reproduction-robustness": compute_overlap_result(
        repro_df, lambda r: r["robustness_bucket"], ROBUSTNESS_BUCKETS
    ),
}

OUT_DATA.write_text(json.dumps(result), encoding="utf-8")
OUT_META.write_text(json.dumps({
    "last_updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "n_total": {k: v["overview"]["n_total"] for k, v in result.items()},
    "source": "scripts/compute_author_overlap.py",
}, indent=2), encoding="utf-8")

for kind, r in result.items():
    ov = r["overview"]
    print(f"{kind}: n_total={ov['n_total']}, overlap={ov['n_overlap']} ({ov['pct_overlap']}%), "
          f"no_overlap={ov['n_no_overlap']}, unknown={ov['n_unknown']}"
          + (" [insufficient n]" if ov["insufficient_n"] else ""))
print(f"Written: {OUT_DATA}")
