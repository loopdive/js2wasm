---
id: 506
title: "Remove redundant conformance-report.html"
status: done
created: 2026-03-18
updated: 2026-04-14
completed: 2026-04-14
priority: low
feasibility: easy
goal: developer-experience
files:
  benchmarks/results/conformance-report.html:
    new: []
    breaking:
      - "delete file — redundant with report.html"
---
# #506 — Remove redundant conformance-report.html

## Status: open

`benchmarks/results/conformance-report.html` is a subset of `benchmarks/report.html` — same conformance data, fewer features. `report.html` already renders conformance + benchmarks + trends. No reason to maintain two files.

## Tasks

1. Delete `benchmarks/results/conformance-report.html`
2. Check if anything links to it (playground, README, other HTML files) and update references to `report.html`

## Complexity: XS
