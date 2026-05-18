#!/usr/bin/env Rscript
# ETWFE event-study (Poisson, study+year FE, clustered SE) for Citation Impact.
# Reads data/originals.json, writes data/fect_results.json.
# Typical run time < 2 min — safe for weekly GitHub Actions.

suppressPackageStartupMessages({
  library(jsonlite)
  library(etwfe)
})

# ── Resolve project root ─────────────────────────────────────────────────────
args     <- commandArgs(trailingOnly = FALSE)
file_arg <- sub("^--file=", "", grep("^--file=", args, value = TRUE))
if (length(file_arg) > 0) {
  root <- normalizePath(file.path(dirname(file_arg[[1]]), ".."), mustWork = FALSE)
} else {
  root <- normalizePath(getwd(), mustWork = FALSE)
  if (basename(root) == "scripts") root <- dirname(root)
}

originals_path <- file.path(root, "data", "originals.json")
out_path       <- file.path(root, "data", "fect_results.json")

if (!file.exists(originals_path)) stop("originals.json not found at ", originals_path)

# ── Build balanced panel from per-study timelines ────────────────────────────
orig <- fromJSON(originals_path, simplifyVector = FALSE)$studies
cat("Loaded", length(orig), "studies\n")

build_panel <- function(studies) {
  cur_year <- as.integer(format(Sys.Date(), "%Y"))
  rows <- lapply(names(studies), function(doi) {
    s <- studies[[doi]]
    if (is.null(s$year) || is.null(s$first_replication_year)) return(NULL)
    if (is.null(s$first_replication_outcome))                  return(NULL)
    if (!s$first_replication_outcome %in% c("successful", "failed", "mixed")) return(NULL)

    year_o   <- as.integer(s$year)
    treat_yr <- as.integer(s$first_replication_year)
    # Skip if replication happened before publication (data error)
    if (treat_yr <= year_o) return(NULL)
    outcome  <- s$first_replication_outcome
    tl       <- s$timeline
    if (length(tl) == 0) return(NULL)

    tl_yr     <- as.character(sapply(tl, `[[`, "year"))
    cite_ct   <- sapply(tl, function(t)
      as.integer(t$only + t$with_successful + t$with_failed + t$with_mixed))
    cocite_ct <- sapply(tl, function(t)
      as.integer(t$with_successful + t$with_failed + t$with_mixed))
    names(cite_ct) <- names(cocite_ct) <- tl_yr

    years <- seq(year_o, cur_year)
    data.frame(
      doi_queried            = doi,
      year                   = years,
      first_replication_year = treat_yr,
      outcome                = outcome,
      n_citations = as.integer(ifelse(as.character(years) %in% names(cite_ct),
                                      cite_ct[as.character(years)], 0L)),
      n_nococit   = as.integer(ifelse(as.character(years) %in% names(cocite_ct),
                                      cocite_ct[as.character(years)], 0L)),
      stringsAsFactors = FALSE
    )
  })
  rows <- rows[!sapply(rows, is.null)]
  if (length(rows) == 0) return(data.frame())
  do.call(rbind, rows)
}

panel <- build_panel(orig)
cat("Panel:", nrow(panel), "rows,", length(unique(panel$doi_queried)), "studies\n")

# ── ETWFE helper ─────────────────────────────────────────────────────────────
LO <- -10L; HI <- 10L

run_etwfe <- function(df, depvar) {
  empty <- list(event_time = integer(0), att_est = numeric(0),
                att_lo = numeric(0), att_hi = numeric(0), n_units = 0L)
  if (nrow(df) < 30 || length(unique(df$doi_queried)) < 5) return(empty)

  df$event_time <- df$year - df$first_replication_year
  df <- df[df$event_time >= LO & df$event_time <= HI, ]
  if (nrow(df) < 30) return(empty)

  tryCatch({
    fml <- as.formula(sprintf("%s ~ 0 | doi_queried + year", depvar))
    fit <- etwfe(
      fml  = fml,
      tvar = year,
      gvar = first_replication_year,
      data = df,
      vcov = ~doi_queried,
      family = poisson()
    )
    eff <- emfx(fit, type = "event")

    # Ensure t=-1 is present (reference period, AME = 0 by construction)
    if (!(-1L) %in% eff$.event) {
      eff <- rbind(
        data.frame(.event = -1L, dydx = 0, std.error = 0,
                   conf.low = 0, conf.high = 0),
        eff
      )
    }

    keep <- eff$.event >= LO & eff$.event <= HI
    eff  <- eff[keep, ]
    eff  <- eff[order(eff$.event), ]

    list(
      event_time = as.integer(eff$.event),
      att_est    = round(eff$dydx,      4),
      att_lo     = round(eff$conf.low,  4),
      att_hi     = round(eff$conf.high, 4),
      n_units    = length(unique(df$doi_queried))
    )
  }, error = function(e) {
    cat("  ETWFE error (", depvar, "):", conditionMessage(e), "\n")
    empty
  })
}

# ── Run per outcome group ─────────────────────────────────────────────────────
outcome_groups <- list(
  all        = c("successful", "failed", "mixed"),
  successful = "successful",
  failed     = "failed",
  mixed      = "mixed"
)

results <- list()
for (grp in names(outcome_groups)) {
  cat("Running ETWFE for:", grp, "\n")
  df_grp <- panel[panel$outcome %in% outcome_groups[[grp]], ]
  cit  <- run_etwfe(df_grp, "n_citations")
  coc  <- run_etwfe(df_grp, "n_nococit")
  cat("  citations n_units =", cit$n_units,
      " | cocitations n_units =", coc$n_units, "\n")
  results[[grp]] <- list(citations = cit, cocitations = coc)
}

results$last_updated <- format(Sys.time(), "%Y-%m-%dT%H:%M:%SZ", tz = "UTC")
results$model        <- "ETWFE (Poisson, study+year FE, clustered SE by study)"

writeLines(toJSON(results, auto_unbox = TRUE, pretty = FALSE, null = "null"), out_path)
cat("✔ Wrote", out_path, "\n")
