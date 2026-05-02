---
id: 899
title: "Extend compile-time TDZ elimination to provably safe closure captures"
status: done
created: 2026-04-02
updated: 2026-04-14
completed: 2026-04-14
priority: medium
feasibility: medium
goal: error-model
files:
  src/codegen/expressions.ts:
    modify:
      - "Refine analyzeTdzAccess for closure capture reads that are provably after initialization"
  src/codegen/closures.ts:
    modify:
      - "Preserve correct closure capture semantics while avoiding unnecessary TDZ runtime bookkeeping"
  tests/issue-800.test.ts:
    modify:
      - "Add closure-focused TDZ compile-away regression coverage"
---
# #899 -- Extend compile-time TDZ elimination to provably safe closure captures

## Problem

Issue `#800` compiled away many runtime TDZ checks using static analysis, but it intentionally stayed conservative for closures.

That means closure captures can still retain runtime TDZ flags/checks even when the compiler can prove the capture is only observed after initialization.

This adds overhead and code size in cases where the source ordering is statically safe, but the compiler currently falls back to the dynamic TDZ path because the read crosses a function boundary.

## Background

Completed issue:

- [#800](/Users/thomas/Documents/Arbeit/Startup/Projekte/Mosaic/code/@loopdive/ts2wasm/plan/issues/sprints/0/800.md) — compile away TDZ checks with static analysis

Current behavior from `#800`:

1. Access after declaration in straight-line code → skip runtime check
2. Access before declaration in straight-line code → emit throw directly
3. Access in closure or loop → keep runtime flag check conservatively

The missing optimization is case 3 for closure captures that are still statically provable.

## Requirements

1. Extend TDZ static analysis to recognize closure captures that are definitely observed only after initialization
2. Eliminate runtime TDZ flag checks for provably safe closure reads
3. Preserve runtime checks for genuinely ambiguous cross-function/capture cases
4. Do not regress TDZ correctness for nested functions, callbacks, IIFEs, or lifted captures
5. Add tests covering both:
   - safe closure cases that should compile away TDZ checks
   - unsafe closure cases that must still throw or retain checks

## Acceptance criteria

- provably safe closure captures no longer emit unnecessary runtime TDZ checks
- ambiguous closure/capture cases still preserve correct TDZ behavior
- generated WAT is smaller/cleaner in the proven-safe closure cases
- existing TDZ and closure correctness tests continue to pass
