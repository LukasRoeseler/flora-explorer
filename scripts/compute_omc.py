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


if __name__ == "__main__":
    main()
