# Contributing to FLoRA Explorer

Thanks for your interest in contributing! This project is a static,
GitHub-Pages dashboard based on the [FORRT Library of Replication Attempts
(FLoRA)](https://forrt.org/replication-hub/flora), and we'd love help
making it a richer window into the replication landscape.

## Adding dashboards or tabs

We especially welcome contributions of **new tabs or views** that help
readers understand replication patterns from a different angle —
whether that's a different lens on the existing FLoRA data
(e.g. topic breakdowns, author-network views), a new visualisation of an existing pipeline's output, or an entirely new data source that complements FLoRA.

If you have an idea for a dashboard, feel free to open an issue to
discuss it before building — it's a good way to get early feedback on
scope and data sourcing, and to check nobody else is already working on
something similar.

### Keep it automated

Every tab in this dashboard is backed by a scheduled GitHub Actions
workflow that recomputes its data and commits the refreshed JSON/CSV
back to the repo. There is no manual data-wrangling step and no
build/server to maintain. If your dashboard needs its own new data
(rather than just visualising an existing pipeline's output), add a
workflow following the same model:

- **Daily** refresh for cheap, simple computations (e.g. snapshot pulls
  and re-slicing or re-aggregating data).
- **Weekly/monthly** refresh for heavier computation, such as anything
  that calls external APIs at volume, runs statistical models, or
  otherwise consumes substantial GitHub Actions minutes. In these
  cases, consider what can be cached and what needs to be recomputed
  for each update.

In both cases:

- The workflow should write its output as static JSON (plus a
  `*_meta.json` with a timestamp, following the existing convention) so
  the frontend can render it with a plain `fetch()` — no server-side
  logic.
- Data files and caches should be committed back to the repo by the
  workflow itself (see `.github/workflows/*.yml` for the existing
  commit-and-push pattern), so the dashboard works from a plain
  `git clone` + GitHub Pages deploy with no external services beyond
  what the workflow calls.
- Prefer reusing an existing cache (e.g. `cache/oc/`,
  `cache/openalex_venues.json`) or adding a new one over re-fetching the
  same external data or estimating the same model on every run.

## Submitting a change

1. Fork the repo and create a branch for your change.
2. If you're adding a new dashboard/tab, include:
   - The frontend code (a new tab in `index.html` plus JS in
     `assets/`, or an extension of an existing tab).
   - The script(s) that compute its data, under `scripts/`.
   - A GitHub Actions workflow under `.github/workflows/` that runs
     those scripts on the appropriate daily/monthly schedule and
     commits the result.
   - A short update to the README's tab table (under "Five tabs") and
     "Layout" section.
3. Test the data pipeline locally before opening a PR (see "Running
   data refreshes locally" in the README).
4. Open a PR describing what the dashboard shows and why it's a useful
   addition to the replication landscape.

Smaller fixes (bug reports, copy tweaks, styling improvements) are
welcome too — no need to follow the full checklist above for those.
