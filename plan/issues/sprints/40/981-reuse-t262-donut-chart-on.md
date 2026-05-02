---
id: 981
title: "Reuse t262-donut chart on report page, refactor as standalone component"
status: done
created: 2026-04-06
updated: 2026-04-14
completed: 2026-04-14
priority: medium
feasibility: medium
reasoning_effort: high
goal: test-infrastructure
---
# #981 — Reuse donut chart on report page

## Problem

The landing page has a `<t262-donut>` web component (in `components/t262-charts.js`) with animated needle, glow, and orbit stats. The report page (`public/benchmarks/results/report.html`) has its own separate SVG donut implementation. These should be unified — the report page should use the same `<t262-donut>` component.

## What to build

1. Ensure `<t262-donut>` works standalone (already does — reads from JSON src attribute)
2. Add `<script src="../../components/t262-charts.js"></script>` to the report page
3. Replace the report page's custom donut SVG with `<t262-donut src="test262-report.json">`
4. Keep the report's stat cards and history table — only replace the donut visualization
5. Ensure the donut matches the report page's context (may need to hide orbit stats or adjust size)

## Acceptance Criteria

- Report page uses `<t262-donut>` component, not its own SVG
- Same animated needle + glow as landing page
- Report-specific features (strict toggle) still work
- No duplicate donut code between landing page and report

## Implementation Notes

- Added `<t262-donut id="donut-chart">` to `#content` div in report.html, between the stats-row and the Conformance Trend line chart
- Added `<script src="../../components/t262-charts.js"></script>` before site-nav.js
- `loadReport()` now tracks `reportUrl` (the URL that successfully loaded), used as the donut's `src` attribute
- Strict toggle wires to the donut's `include-sloppy` attribute: checked (strict-only) → no attr; unchecked (all tests) → attr present
- The `t262-donut` component's `include-sloppy` logic aligns perfectly: absent = use `no_sloppy_summary`, present = use `summary`
- No changes to shared component code or compiler source
