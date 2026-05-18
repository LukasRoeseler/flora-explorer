"""
Compute the Mean Citedness (OMC) analysis and write chart-ready JSON.
Pure Python/statsmodels — no R required.

Outputs:
  data/impact_factor_data.json   — histogram + GAM curve + overview stats
  data/impact_factor_meta.json   — { last_updated, n_rows_with_omc, source }

Called by refresh-impact-factor.yml after compute_omc.py.
"""
from __future__ import annotations

import json
import random
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
import statsmodels.api as sm
from scipy.special import expit

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"

IN_CSV    = DATA_DIR / "flora_with_omc.csv"
DISC_JSON = DATA_DIR / "disciplines.json"
OUT_DATA  = DATA_DIR / "impact_factor_data.json"
OUT_META  = DATA_DIR / "impact_factor_meta.json"

if not IN_CSV.exists():
    raise SystemExit(f"{IN_CSV} not found. Run compute_omc.py first.")


# ── Load & filter ─────────────────────────────────────────────────────────────
raw = pd.read_csv(IN_CSV, low_memory=False, na_values=["", "NA"])

# Replications only (same logic as refresh_data.py)
type_col = "type"
if type_col in raw.columns:
    raw = raw[raw[type_col].astype(str).str.contains("replication", case=False, na=False) &
              ~raw[type_col].astype(str).str.contains("reproduc",   case=False, na=False)]

raw["impact_factor"] = pd.to_numeric(raw.get("impact_factor"), errors="coerce")
raw["outcome_lc"] = raw.get("outcome", pd.Series(dtype=str)).astype(str).str.lower().str.strip()

df_all = raw[raw["impact_factor"].notna() & (raw["impact_factor"] < 35)].copy()

# Discipline lookup
disc_map: dict[str, str] = {}
if DISC_JSON.exists():
    discs = json.loads(DISC_JSON.read_text(encoding="utf-8"))
    for disc, journals in discs.items():
        for j in journals:
            disc_map[j.lower().strip()] = disc

def get_disc(j):
    return disc_map.get(str(j).lower().strip(), "Uncategorized") if pd.notna(j) else "Uncategorized"

df_all["discipline"] = df_all.get("journal_o", pd.Series(dtype=str)).map(get_disc)

# ── Overview stats ────────────────────────────────────────────────────────────
oc = df_all["outcome_lc"]
overview = {
    "n_total":        int(len(df_all)),
    "n_success":      int((oc == "successful").sum()),
    "n_failed":       int((oc == "failed").sum()),
    "n_mixed":        int((oc == "mixed").sum()),
    "n_inconclusive": int((oc == "inconclusive").sum()),
    "n_journals":     int(df_all["journal_o"].dropna().nunique()) if "journal_o" in df_all.columns else 0,
    "n_disciplines":  int((df_all["discipline"] != "Uncategorized").sum() > 0 and
                          df_all.loc[df_all["discipline"] != "Uncategorized", "discipline"].nunique()),
}

# ── Histogram (bin width 0.5, range 0–20) ─────────────────────────────────────
breaks = np.arange(0, 20.5, 0.5)
hist_data = []
for lo, hi in zip(breaks[:-1], breaks[1:]):
    sub = df_all[(df_all["impact_factor"] >= lo) & (df_all["impact_factor"] < hi)]
    so = sub["outcome_lc"]
    hist_data.append({
        "bin_lo":       round(float(lo), 1),
        "bin_hi":       round(float(hi), 1),
        "successful":   int((so == "successful").sum()),
        "failed":       int((so == "failed").sum()),
        "mixed":        int((so == "mixed").sum()),
        "inconclusive": int((so == "inconclusive").sum()),
    })

# ── GAM (logistic, spline basis via polynomial in log-scale) ──────────────────
stats_out = {"edf": None, "chi_sq": None, "p_val": None, "r2": None,
             "n_model": 0}
gam_curve: list = []
jitter:    list = []

df_bin = df_all[df_all["outcome_lc"].isin(["successful", "failed"])].copy()
df_bin["outcome_binary"] = (df_bin["outcome_lc"] == "successful").astype(int)
df_bin["omc_log"] = np.log1p(df_bin["impact_factor"])
df_bin = df_bin.dropna(subset=["omc_log", "outcome_binary"])

if len(df_bin) >= 30:
    try:
        x = df_bin["omc_log"].values
        y = df_bin["outcome_binary"].values

        # Natural cubic spline via polynomial basis (degree 4 in log-scale)
        X = np.column_stack([np.ones(len(x)), x, x**2, x**3, x**4])
        model = sm.GLM(y, X, family=sm.families.Binomial())
        res = model.fit(disp=False)

        # McFadden R²
        null_ll  = float(sm.GLM(y, np.ones((len(y), 1)),
                                 family=sm.families.Binomial()).fit(disp=False).llf)
        full_ll  = float(res.llf)
        r2 = round(1 - full_ll / null_ll, 4) if null_ll != 0 else None

        # Wald chi-sq for smooth terms (sum of squared z-scores for non-intercept)
        z = res.tvalues[1:]
        chi_sq = round(float(np.sum(z ** 2)), 3)
        p_val  = round(float(sm.stats.chisqprob(chi_sq, len(z))), 4)
        edf    = round(float(len(z)), 1)  # df consumed by smooth

        stats_out = {"edf": edf, "chi_sq": chi_sq, "p_val": p_val,
                     "r2": r2, "n_model": int(len(df_bin))}

        # Prediction grid
        omc_seq = np.linspace(float(df_bin["impact_factor"].min()),
                              min(float(df_bin["impact_factor"].max()), 20.0),
                              150)
        xl = np.log1p(omc_seq)
        X_pred = np.column_stack([np.ones(150), xl, xl**2, xl**3, xl**4])
        pred   = res.get_prediction(X_pred)
        pf     = pred.summary_frame(alpha=0.05)

        for i in range(150):
            gam_curve.append({
                "omc":  round(float(omc_seq[i]), 4),
                "p":    round(float(pf["mean"].iloc[i]),             4),
                "p_lo": round(float(pf["mean_ci_lower"].iloc[i]),    4),
                "p_hi": round(float(pf["mean_ci_upper"].iloc[i]),    4),
            })

        # Jitter (max 800 points)
        jdf = df_bin[["impact_factor", "outcome_binary"]].copy()
        if len(jdf) > 800:
            jdf = jdf.sample(800, random_state=42)
        for _, row in jdf.iterrows():
            jitter.append({
                "omc":     round(float(row["impact_factor"]), 3),
                "outcome": int(row["outcome_binary"]),
            })

    except Exception as e:
        print(f"  ! GAM fitting error: {e}")

# ── Write outputs ─────────────────────────────────────────────────────────────
result = {
    "overview":  overview,
    "stats":     stats_out,
    "histogram": hist_data,
    "gam_curve": gam_curve,
    "jitter":    jitter,
}

OUT_DATA.write_text(json.dumps(result, allow_nan=False), encoding="utf-8")
print(f"✔ Wrote {OUT_DATA.relative_to(ROOT)}")

meta = {
    "last_updated":    datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "n_rows_with_omc": overview["n_total"],
    "source":          "scripts/compute_impact_json.py",
}
OUT_META.write_text(json.dumps(meta, indent=2), encoding="utf-8")
print(f"✔ Wrote {OUT_META.relative_to(ROOT)}")
print(f"  n_total={overview['n_total']}, n_model={stats_out['n_model']}, "
      f"gam_pts={len(gam_curve)}, jitter_pts={len(jitter)}")
