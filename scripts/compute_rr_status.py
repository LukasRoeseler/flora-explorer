"""
Determine which FLoRA replications were published as Registered Reports (RR).

Matches each replication's DOI/title against the FORRT Zotero group library
"Registered Reports" (https://www.zotero.org/groups/5937153/registered_reports),
a hand-curated catalogue of studies published in the Registered Report format.
A replication that appears in that library is classified as an RR; every other
replication falls into the "rest" (non-RR) group. Outcome counts are then
compared between the two groups.

Note this only tells us whether the *replication itself* was published as a
Registered Report - not whether the original study was. Coverage of the RR
library is itself incomplete, so "non-RR" really means "not (yet) found in the
RR library", not "confirmed to not be a Registered Report".

Output:
  data/rr_status_data.json
  data/rr_status_meta.json
"""
from __future__ import annotations

import json
import os
import re
import time
import unicodedata
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd
import requests

ROOT     = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
IN_CSV   = DATA_DIR / "flora.csv"
OUT_DATA = DATA_DIR / "rr_status_data.json"
OUT_META = DATA_DIR / "rr_status_meta.json"

ZOTERO_GROUP_ID = 5937153
ZOTERO_API      = f"https://api.zotero.org/groups/{ZOTERO_GROUP_ID}/items"
ZOTERO_LIBRARY_URL = "https://www.zotero.org/groups/5937153/registered_reports/library"
PAGE_SIZE = 100

MY_EMAIL = os.environ.get("MY_EMAIL", "")
HEADERS = {
    "User-Agent": f"flora-explorer-rr-status ({MY_EMAIL})" if MY_EMAIL else "flora-explorer-rr-status",
}

if not IN_CSV.exists():
    raise SystemExit(f"{IN_CSV} not found.")


def normalize_doi(doi) -> str:
    """Lowercase, strip whitespace/prefixes so DOIs compare equal regardless of formatting."""
    if not isinstance(doi, str) or not doi.strip():
        return ""
    d = doi.strip().lower()
    d = re.sub(r"^https?://(dx\.)?doi\.org/", "", d)
    d = re.sub(r"^doi:\s*", "", d)
    return d.strip("/ ")


def normalize_title(title) -> str:
    """Lowercase, strip diacritics/punctuation/whitespace to a compact alnum key."""
    if not isinstance(title, str) or not title.strip():
        return ""
    t = unicodedata.normalize("NFD", title)
    t = "".join(c for c in t if unicodedata.category(c) != "Mn")
    return re.sub(r"[^a-z0-9]", "", t.lower())


def fetch_rr_library() -> tuple[set[str], set[str]]:
    """Fetch every item from the RR Zotero group library, return (dois, titles) sets."""
    dois: set[str] = set()
    titles: set[str] = set()
    start = 0
    while True:
        for attempt in range(5):
            try:
                resp = requests.get(
                    ZOTERO_API,
                    params={"format": "json", "limit": PAGE_SIZE, "start": start},
                    headers=HEADERS,
                    timeout=60,
                )
            except requests.exceptions.RequestException as exc:
                if attempt == 4:
                    raise
                wait = 2 ** attempt
                print(f"  request error ({exc}); retrying in {wait}s …")
                time.sleep(wait)
                continue
            if resp.status_code == 429 or "Backoff" in resp.headers:
                wait = int(resp.headers.get("Backoff", resp.headers.get("Retry-After", 5)))
                time.sleep(wait)
                continue
            resp.raise_for_status()
            break
        batch = resp.json()
        if not batch:
            break
        for item in batch:
            data = item.get("data", {})
            if data.get("itemType") in ("attachment", "note"):
                continue
            doi = normalize_doi(data.get("DOI", ""))
            title = normalize_title(data.get("title", ""))
            if doi:
                dois.add(doi)
            if title:
                titles.add(title)
        if len(batch) < PAGE_SIZE:
            break
        start += PAGE_SIZE
        time.sleep(0.2)
    return dois, titles


print("Fetching Registered Reports library from Zotero …")
rr_dois, rr_titles = fetch_rr_library()
print(f"RR library: {len(rr_dois)} DOIs, {len(rr_titles)} titles")


# ── Load & filter to replications ─────────────────────────────────────────────
df = pd.read_csv(IN_CSV, low_memory=False, na_values=["", "NA"])

if "type" in df.columns:
    mask = (
        df["type"].astype(str).str.contains("replication", case=False, na=False) &
        ~df["type"].astype(str).str.contains("reproduc",   case=False, na=False)
    )
    df = df[mask].copy()

df["outcome_lc"] = df.get("outcome", pd.Series(dtype=str)).astype(str).str.lower().str.strip()


def _classify(row) -> bool | None:
    doi = normalize_doi(row.get("doi_r", ""))
    title = normalize_title(row.get("title_r", ""))
    if not doi and not title:
        return None
    if doi and doi in rr_dois:
        return True
    if title and title in rr_titles:
        return True
    return False


df["is_rr"] = df.apply(_classify, axis=1)

df_known = df[df["is_rr"].notna()].copy()
n_total   = len(df_known)
n_rr      = int(df_known["is_rr"].sum())
n_non_rr  = n_total - n_rr
n_unknown = int(df["is_rr"].isna().sum())

OUTCOMES = ["successful", "failed", "mixed", "inconclusive"]

by_outcome: dict[str, dict[str, int]] = {}
for grp, flag in [("rr", True), ("non_rr", False)]:
    sub = df_known.loc[df_known["is_rr"] == flag, "outcome_lc"]
    by_outcome[grp] = {oc: int((sub == oc).sum()) for oc in OUTCOMES}

def _clean(v):
    """Convert pandas NaN to None; JSON has no NaN literal that JS's JSON.parse accepts."""
    return None if pd.isna(v) else v


rr_studies = [
    {
        "title_r":   _clean(row.get("title_r")),
        "journal_r": _clean(row.get("journal_r")),
        "year_r":    _clean(row.get("year_r")),
        "outcome":   _clean(row.get("outcome")),
        "doi_r":     _clean(row.get("doi_r")),
        "url_r":     _clean(row.get("url_r")),
    }
    for _, row in df_known.loc[df_known["is_rr"]].iterrows()
]
rr_studies.sort(key=lambda s: (s["year_r"] is None, s["year_r"]), reverse=True)

result = {
    "overview": {
        "n_total":     n_total,
        "n_rr":        n_rr,
        "n_non_rr":    n_non_rr,
        "n_unknown":   n_unknown,
        "pct_rr":      round(100 * n_rr     / n_total, 1) if n_total else 0,
        "pct_non_rr":  round(100 * n_non_rr / n_total, 1) if n_total else 0,
    },
    "by_outcome": by_outcome,
    "rr_studies": rr_studies,
}

OUT_DATA.write_text(json.dumps(result), encoding="utf-8")
OUT_META.write_text(json.dumps({
    "last_updated":       datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "n_total":            n_total,
    "n_rr_library_items": len(rr_dois | rr_titles),
    "source":             "scripts/compute_rr_status.py",
    "source_url":         ZOTERO_LIBRARY_URL,
}, indent=2), encoding="utf-8")

print(f"n_total={n_total}, rr={n_rr} ({result['overview']['pct_rr']}%), "
      f"non_rr={n_non_rr}, unknown={n_unknown}")
print(f"Written: {OUT_DATA}")
