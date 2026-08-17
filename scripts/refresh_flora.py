"""
Daily snapshot of the FLoRA dataset.

Downloads the current flora.csv from the FReD-data repository and commits it
to data/flora.csv along with a small meta sidecar (data/flora_meta.json) that
records the timestamp and a few summary counts. The FLoRA Explorer frontend
reads these files so it can display a "last updated" indicator.

Reproduction rows currently arrive from upstream with `outcome` blank/"NA":
the FReD-data pipeline now sources reproductions from a separate two-axis
Google Sheet (outcome_computational/outcome_robustness columns) but has a bug
where that data is never merged into flora.csv's single `outcome` column
(forrtproject/FReD-data's prepare_flora.qmd bind_rows()s the two sheets
together, and since the reproductions sheet has no `outcome` column at all,
every reproduction-sourced row silently gets NA there - confirmed against the
pipeline source and its commit history as of 2026-08-17). Until that's fixed
upstream, this script pulls the same Google Sheet directly and backfills
`outcome` for any reproduction row still missing it, joining the two axes into
the same "computational, robustness" comma format the handful of
legacy-format rows already use - so every downstream script's parser keeps
working unchanged.
"""
from __future__ import annotations

import csv
import io
import json
import re
from datetime import datetime, timezone
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
DATA_DIR.mkdir(exist_ok=True)

FLORA_URL = "https://raw.githubusercontent.com/forrtproject/FReD-data/refs/heads/main/output/flora.csv"
REPRODUCTIONS_GSHEET_URL = (
    "https://docs.google.com/spreadsheets/d/e/2PACX-1vT0VnLyrf9GCYXtN6l1DgaoLlg6H5r-08Op9eJzSripS1QBSHL031Arc27yUDe0YY7cB4TOnYMm2Vh1"
    "/pub?gid=984458430&single=true&output=csv"
)
OUT_CSV = DATA_DIR / "flora.csv"
OUT_META = DATA_DIR / "flora_meta.json"

# The frontend (assets/app.js) only ever reads these columns. The upstream CSV also
# carries apa_ref/bibtex_ref and other bibliographic fields that nothing displays,
# which roughly doubles the payload the browser has to download and parse - so keep
# only what's used in the committed snapshot. The upstream fallback URL in app.js is
# untouched and still serves the full CSV.
KEEP_COLUMNS = [
    "doi_o", "title_o", "author_o", "journal_o", "year_o",
    "doi_r", "title_r", "author_r", "journal_r", "year_r", "url_r",
    "outcome", "outcome_quote", "type",
]


def normalize_doi(doi) -> str:
    """Lowercase, strip whitespace/prefixes so DOIs compare equal regardless of formatting."""
    if not isinstance(doi, str) or not doi.strip():
        return ""
    d = doi.strip().lower()
    d = re.sub(r"^https?://(dx\.)?doi\.org/", "", d)
    d = re.sub(r"^doi:\s*", "", d)
    return d.strip("/ ")


def normalize_url(url) -> str:
    if not isinstance(url, str) or not url.strip():
        return ""
    return url.strip().lower().rstrip("/")


def fetch_reproduction_outcomes() -> tuple[dict, dict]:
    """Load the reproductions Google Sheet, returning (by_doi, by_url) lookups of
    normalised doi_r/url_r -> "computational, robustness" combined outcome string.
    Rows explicitly marked "validated - discarded" are excluded; everything else
    (not yet reviewed, or validated-accepted) is kept - these are already-included
    FLoRA rows that just need their real coded outcome recovered, not re-adjudicated."""
    r = requests.get(REPRODUCTIONS_GSHEET_URL, timeout=60)
    r.raise_for_status()
    reader = csv.DictReader(io.StringIO(r.text))
    by_doi: dict[str, str] = {}
    by_url: dict[str, str] = {}
    for row in reader:
        if (row.get("validation") or "").strip().lower() == "validated - discarded":
            continue
        computational = (row.get("outcome_computational") or "").strip()
        robustness = (row.get("outcome_robustness") or "").strip()
        if not computational and not robustness:
            continue
        combined = f"{computational}, {robustness}"
        doi_key = normalize_doi(row.get("doi_r", ""))
        url_key = normalize_url(row.get("url_r", ""))
        if doi_key:
            by_doi[doi_key] = combined
        if url_key:
            by_url[url_key] = combined
    return by_doi, by_url


def main():
    print(f"Fetching {FLORA_URL} …")
    r = requests.get(FLORA_URL, timeout=120)
    r.raise_for_status()
    text = r.text.lstrip("﻿")  # strip BOM so "doi_o" (not BOM-prefixed) is the fieldname

    # Sanity-check the CSV before committing
    reader = csv.DictReader(io.StringIO(text))
    rows = list(reader)
    if not rows:
        raise SystemExit("Downloaded flora.csv has no rows; aborting.")

    print(f"Fetching reproduction outcomes from Google Sheet …")
    try:
        by_doi, by_url = fetch_reproduction_outcomes()
    except requests.exceptions.RequestException as e:
        print(f"  ! could not fetch reproduction outcomes ({e}); leaving flora.csv's outcome as-is")
        by_doi, by_url = {}, {}

    n_backfilled = 0
    for row in rows:
        if "reproduc" not in (row.get("type") or "").lower():
            continue
        current = (row.get("outcome") or "").strip()
        if current and current.upper() != "NA":
            continue  # already has a real coded outcome - don't overwrite it
        doi_key = normalize_doi(row.get("doi_r", ""))
        url_key = normalize_url(row.get("url_r", ""))
        combined = by_doi.get(doi_key) or by_url.get(url_key)
        if combined:
            row["outcome"] = combined
            n_backfilled += 1
    print(f"✔ Backfilled outcome for {n_backfilled} reproduction rows from the gsheet")

    n_rows = len(rows)
    upstream_columns = reader.fieldnames or []
    columns = [c for c in KEEP_COLUMNS if c in upstream_columns]

    out = io.StringIO()
    writer = csv.DictWriter(out, fieldnames=columns, extrasaction="ignore")
    writer.writeheader()
    writer.writerows(rows)
    OUT_CSV.write_text(out.getvalue(), encoding="utf-8")

    meta = {
        "last_updated": datetime.now(timezone.utc).isoformat(),
        "source_url": FLORA_URL,
        "n_rows": n_rows,
        "n_reproduction_outcomes_backfilled": n_backfilled,
        "columns": columns,
    }
    OUT_META.write_text(json.dumps(meta, indent=2), encoding="utf-8")
    print(f"✔ Wrote {OUT_CSV.relative_to(ROOT)} ({n_rows} rows)")
    print(f"✔ Wrote {OUT_META.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
