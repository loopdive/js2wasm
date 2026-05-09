---
id: 1398
sprint: 52
title: "report: edition filter on category table — per-category edition breakdown"
status: done
created: 2026-05-09
priority: low
feasibility: medium
reasoning_effort: low
task_type: infra
area: reporting
---
# #1396 — Report: edition filter on category table

## Background

The report page (`public/benchmarks/report.html`) has an edition timeline slider that
filters the conformance summary donut chart. When the user selects e.g. "ES2022", the
donut updates to show cumulative conformance through ES2022. The category table below
the slider does NOT filter — it always shows all-edition aggregate counts.

## Problem

Users want to see which categories are problematic within a specific ES edition. Selecting
ES2015 in the slider should filter the category table to show only categories that have
tests introduced in ≤ ES2015, with the counts scoped to that edition's tests.

Currently impossible: `test262-report.json` categories have only all-editions aggregate
counts (`pass`, `fail`, `compile_error`, `skip`). No per-edition breakdown exists.

## Fix

Two-part change:

### Part 1 — Data pipeline (`scripts/build-test262-report.mjs`)

Build a static `edition → file` lookup table from the test262 corpus (test files have
`esid` / `es6id` YAML frontmatter indicating which edition introduced them). Generate
this lookup once as a separate JSON or embed it into the report:

```json
{
  "language/expressions/class/elements": {
    "ES2022": { "pass": 42, "fail": 18, "compile_error": 3, "skip": 0 },
    "ES2015": { "pass": 10, "fail": 5, "compile_error": 0, "skip": 0 }
  }
}
```

Options:
- **A (recommended)**: Pre-build a `test262-category-editions.json` alongside
  `test262-report.json` in CI. `build-test262-report.mjs` reads a static
  `test262-edition-map.json` (corpus-derived, checked in) and joins it with the
  JSONL results to produce per-category edition counts.
- **B**: Add `edition` field to each JSONL record during the test run (parse frontmatter
  per file). Adds latency (~100ms for 43K files) but avoids a separate join step.

Option A is cleaner — corpus edition metadata doesn't change per run.

### Part 2 — Frontend (`public/benchmarks/report.html`)

Load `test262-category-editions.json` alongside the main report JSON. In `applyFilters()`:

```js
if (scoreState.editionScope !== "overall") {
  const rank = editionDetail?.limitRank;  // numeric rank for selected edition
  // show category only if it has tests in editions with rank ≤ selected rank
  const editionMatch = categoryHasEditionAtOrBefore(cat.name, rank);
  visible = visible && editionMatch;
}
```

The existing `statusBtnFail` / `statusBtnCE` toggles (added in S51) compose naturally
with this filter — all three criteria AND together.

## Scope

- `scripts/build-test262-report.mjs` — join edition map with JSONL results
- `scripts/build-edition-map.mjs` (new) — one-time corpus scan → `test262-edition-map.json`
- `.github/workflows/test262-sharded.yml` — add edition-map build step if needed
- `public/benchmarks/report.html` — load `test262-category-editions.json`, filter in `applyFilters()`

## Estimated effort

~30–40 minutes agent time (two agents in parallel: pipeline + frontend).

## Notes

- The status filter toggles (CE/Fail) on the category table were shipped in S51 and work
  with current data. This issue adds the edition dimension.
- The `test262-editions.json` file already has aggregate per-edition counts (used by the
  donut); this issue adds the per-category breakdown.
