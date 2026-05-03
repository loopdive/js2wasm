---
id: 1296
sprint: 49
title: "Dogfood: compile dashboard/landing page JS to Wasm using js2wasm"
status: in-progress
created: 2026-05-03
updated: 2026-05-03
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: feature
area: compiler
language_feature: dom-host-imports
goal: compilable
depends_on: [1045]
related: [1033]
---
# #1296 — Dogfood: compile GitHub Pages site JS to Wasm via js2wasm

## Goal

Use js2wasm to compile the dashboard/landing/report page TypeScript to WebAssembly,
replacing the existing browser JavaScript. This is the canonical self-referential demo:
the compiler compiles its own website.

## Background

js2wasm already auto-generates externref host imports from TypeScript declarations
(the `extern class` mechanism). `lib.dom.d.ts` declarations for `document`,
`HTMLElement`, `Event`, `fetch`, etc. are already in scope. DOM API calls in TypeScript
→ Wasm host imports, automatically, from the type definitions.

The architecture:
- Dashboard TypeScript → `dashboard.wasm` (all logic in Wasm)
- Thin JS bootstrap (~50 lines) instantiates the module, passes host imports (`document`, `fetch`, chart refs)
- Chart.js stays in JS; dashboard passes chart update calls through host imports

## What to compile

### Tier 1 — data aggregation (no DOM, pure compute)
Extract the test262 result aggregation logic from `dashboard/build-data.js` into
`dashboard/analytics.ts`:
- Parse `runs/index.json` entries
- Compute per-category pass/fail/CE counts
- Build trend arrays for pass rate over time
- Filter by sprint, category, test path

This is pure TS → Wasm with no DOM; compile with existing js2wasm.

### Tier 2 — dashboard rendering
Compile `dashboard/index.ts` (DOM manipulation, Kanban board updates, chart data
preparation) to Wasm. DOM calls route through externref host imports from `lib.dom.d.ts`.

Required host imports (all auto-generated from TypeScript declarations):
- `document.querySelector` / `getElementById` / `createElement`
- `element.innerHTML` / `textContent` / `classList` / `setAttribute`
- `element.addEventListener`
- `fetch` (via host import)

### Tier 3 — landing page
Compile landing page JS (`public/js/` or inline `<script>`) if any non-trivial logic exists.

## Approach

1. Audit what DOM APIs the dashboard actually uses — `grep -r "document\.\|window\.\|\.classList\|\.innerHTML" dashboard/`
2. Verify those APIs have types in `lib.dom.d.ts` that the extern class scanner picks up
3. Extract pure logic into `dashboard/analytics.ts`, compile it, run it against test data
4. Attempt full `dashboard/index.ts` compile — log failures by category
5. Wire compiled Wasm into the build pipeline (`dashboard/build.ts` or Vite plugin)

## Acceptance criteria

1. `dashboard/analytics.ts` compiles to Wasm and produces correct aggregation output (Tier 1)
2. Attempt Tier 2 — document which DOM APIs work and which hit gaps
3. File follow-up issues for any new compiler gaps found (expected: `addEventListener` callback
   as externref, `fetch` as async host import, `classList.add/remove`)
4. Sprint doc updated with results

## Relationship to #1033 (React)

#1033 is the large-scale DOM host import story (React's full renderer). This issue is
narrower and more immediately valuable: compile js2wasm's own website, proving the
DOM-as-host-imports path works end-to-end on real code we control. Findings feed
directly into #1033's implementation.

## Files

- `dashboard/analytics.ts` (new — extract from build-data.js)
- `dashboard/index.ts` (new or existing — browser entry point)
- `dashboard/build.ts` (update to compile analytics.ts with js2wasm)
- `src/codegen/index.ts` — fix any DOM extern class gaps found

## Expected impact

- Demonstrates js2wasm compiling real DOM-manipulating TypeScript
- Validates extern class auto-generation from lib.dom.d.ts at scale
- Surfaces concrete DOM API gaps → targeted follow-up issues
- Self-referential demo value for launch narrative

## Tier 1 progress (2026-05-03)

`dashboard/analytics.ts` is written and compiles cleanly to a 4828-byte
Wasm module. It exports nine pure-compute aggregation kernels covering
the dashboard's test262-trend math and Kanban issue tally:

- Trend: `passRateBp`, `netChange`, `maxPass`, `minPass`,
  `cumulativeGain`, `cumulativeLoss`
- Filters: `countRunsAboveTotal`, `tallyStatusCount`
- Sprint: `sprintCompletionBp`

Verified by `tests/issue-1296.test.ts` (13 cases, all passing). The test
compiles the module via `compile(src)`, instantiates the binary, then
calls each kernel through scalar `test_*` wrappers (avoiding the
JS↔Wasm GC array boundary). Each result is asserted against an
independent JS reference implementation over the same fixture data
sampled from `benchmarks/results/runs/index.json`. Cross-kernel
consistency check (`gain - loss === netChange`) included.

Tiers 2 and 3 (DOM rendering and landing page) are NOT in scope here —
they require the externref/`extern class` DOM auto-import work tracked
in #1033. Follow-up gap inventory will land in a separate issue.
