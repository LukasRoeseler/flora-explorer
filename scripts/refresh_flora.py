"""
Daily snapshot of the FLoRA dataset.

Downloads the current flora.csv from the FReD-data repository and commits it
to data/flora.csv along with a small meta sidecar (data/flora_meta.json) that
records the timestamp and a few summary counts. The FLoRA Explorer frontend
reads these files so it can display a "last updated" indicator.
"""
from __future__ import annotations

import csv
import io
import json
from datetime import datetime, timezone
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
DATA_DIR.mkdir(exist_ok=True)

FLORA_URL = "https://raw.githubusercontent.com/forrtproject/FReD-data/refs/heads/main/output/flora.csv"
OUT_CSV = DATA_DIR / "flora.csv"
OUT_META = DATA_DIR / "flora_meta.json"


def main():
    print(f"Fetching {FLORA_URL} …")
    r = requests.get(FLORA_URL, timeout=120)
    r.raise_for_status()
    text = r.text

    # Sanity-check the CSV before committing
    reader = csv.DictReader(io.StringIO(text))
    rows = list(reader)
    if not rows:
        raise SystemExit("Downloaded flora.csv has no rows; aborting.")

    n_rows = len(rows)
    columns = reader.fieldnames or []

    OUT_CSV.write_text(text, encoding="utf-8")

    meta = {
        "last_updated": datetime.now(timezone.utc).isoformat(),
        "source_url": FLORA_URL,
        "n_rows": n_rows,
        "columns": columns,
    }
    OUT_META.write_text(json.dumps(meta, indent=2), encoding="utf-8")
    print(f"✔ Wrote {OUT_CSV.relative_to(ROOT)} ({n_rows} rows)")
    print(f"✔ Wrote {OUT_META.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
