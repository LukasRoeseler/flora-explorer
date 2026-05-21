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


# ── Load & filter to replications ─────────────────────────────────────────────
df = pd.read_csv(IN_CSV, low_memory=False, na_values=["", "NA"])

if "type" in df.columns:
    mask = (
        df["type"].astype(str).str.contains("replication", case=False, na=False) &
        ~df["type"].astype(str).str.contains("reproduc",   case=False, na=False)
    )
    df = df[mask].copy()

df["outcome_lc"] = df.get("outcome", pd.Series(dtype=str)).astype(str).str.lower().str.strip()


# ── Compute per-row overlap flag ───────────────────────────────────────────────
def _overlap(row) -> bool | None:
    orig = family_names(row.get("author_o", ""))
    repl = family_names(row.get("author_r", ""))
    if not orig or not repl:
        return None
    return bool(orig & repl)

df["author_overlap"] = df.apply(_overlap, axis=1)

df_known = df[df["author_overlap"].notna()].copy()
n_total     = len(df_known)
n_overlap   = int(df_known["author_overlap"].sum())
n_no_overlap = n_total - n_overlap
n_unknown   = int(df["author_overlap"].isna().sum())

OUTCOMES = ["successful", "failed", "mixed", "inconclusive"]

by_outcome: dict[str, dict[str, int]] = {}
for grp, flag in [("overlap", True), ("no_overlap", False)]:
    sub = df_known.loc[df_known["author_overlap"] == flag, "outcome_lc"]
    by_outcome[grp] = {oc: int((sub == oc).sum()) for oc in OUTCOMES}

result = {
    "overview": {
        "n_total":      n_total,
        "n_overlap":    n_overlap,
        "n_no_overlap": n_no_overlap,
        "n_unknown":    n_unknown,
        "pct_overlap":    round(100 * n_overlap    / n_total, 1) if n_total else 0,
        "pct_no_overlap": round(100 * n_no_overlap / n_total, 1) if n_total else 0,
    },
    "by_outcome": by_outcome,
}

OUT_DATA.write_text(json.dumps(result), encoding="utf-8")
OUT_META.write_text(json.dumps({
    "last_updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "n_total":      n_total,
    "source":       "scripts/compute_author_overlap.py",
}, indent=2), encoding="utf-8")

print(f"n_total={n_total}, overlap={n_overlap} ({result['overview']['pct_overlap']}%), "
      f"no_overlap={n_no_overlap}, unknown={n_unknown}")
print(f"Written: {OUT_DATA}")
