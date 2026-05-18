#!/usr/bin/env Rscript
# Render the Mean Citedness analysis to an HTML fragment that the
# FLoRA Explorer frontend injects into the "Mean Citedness" tab.
#
# Outputs:
#   data/impact_factor.html        — the HTML fragment (body content only)
#   data/impact_factor_meta.json   — { last_updated, n_rows, ... }
#   data/impact_factor_figs/       — generated PNGs (referenced from the HTML)

suppressPackageStartupMessages({
  library(rmarkdown)
  library(jsonlite)
})

# Resolve the project root robustly whether invoked as `Rscript scripts/render_impact_factor.R`
# from the repo root or from inside scripts/.
args <- commandArgs(trailingOnly = FALSE)
file_arg <- sub("^--file=", "", grep("^--file=", args, value = TRUE))
if (length(file_arg) > 0) {
  root <- normalizePath(file.path(dirname(file_arg[[1]]), ".."), mustWork = FALSE)
} else {
  root <- normalizePath(getwd(), mustWork = FALSE)
  if (basename(root) == "scripts") root <- dirname(root)
}

rmd_in  <- file.path(root, "scripts", "impact_factor.Rmd")
fig_dir <- file.path(root, "data", "impact_factor_figs")
out_html <- file.path(root, "data", "impact_factor.html")
out_meta <- file.path(root, "data", "impact_factor_meta.json")

if (!file.exists(rmd_in)) stop("impact_factor.Rmd not found at ", rmd_in)
if (!dir.exists(fig_dir)) dir.create(fig_dir, recursive = TRUE)

# Render the .Rmd as an html_fragment so it can be injected into a tab.
# Set the knit working directory to /scripts so the relative paths in the Rmd
# resolve correctly (it reads ../data/flora_with_omc.csv etc.).
rmarkdown::render(
  input        = rmd_in,
  output_format = rmarkdown::html_fragment(self_contained = FALSE,
                                           fig_width = 8, fig_height = 5),
  output_file  = out_html,
  knit_root_dir = file.path(root, "scripts"),
  quiet        = TRUE
)

# Rewrite figure paths so they work from /data/impact_factor.html
html <- readLines(out_html, warn = FALSE)
# Anything like "../data/impact_factor_figs/foo.png" → "impact_factor_figs/foo.png"
html <- gsub("\\.\\./data/impact_factor_figs/", "impact_factor_figs/", html, fixed = FALSE)
writeLines(html, out_html)

# Count source rows for the meta file
n_rows <- tryCatch({
  df <- read.csv(file.path(root, "data", "flora_with_omc.csv"),
                 stringsAsFactors = FALSE, na.strings = c("", "NA"))
  nrow(df[!is.na(suppressWarnings(as.numeric(df$impact_factor))), ])
}, error = function(e) NA_integer_)

meta <- list(
  last_updated = format(Sys.time(), "%Y-%m-%dT%H:%M:%SZ", tz = "UTC"),
  n_rows_with_omc = n_rows,
  source = "scripts/impact_factor.Rmd"
)
writeLines(toJSON(meta, auto_unbox = TRUE, pretty = TRUE), out_meta)

cat("✔ Wrote", out_html, "\n")
cat("✔ Wrote", out_meta, "\n")
