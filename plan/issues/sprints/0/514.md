---
id: 514
title: "Generator/async-gen 'options is not defined' (~684 CE)"
status: done
created: 2026-03-18
updated: 2026-04-14
completed: 2026-03-18
priority: critical
goal: async-model
test262_ce: 684
---
# #514 -- Generator/async-gen "options is not defined" (~684 CE)

## Status: done

684 tests fail with compile error "options is not defined". This is the second-largest single CE pattern after "Unsupported call expression."

### Category breakdown

| Category | Count |
|----------|-------|
| language/statements (generators) | 261 |
| built-ins/Promise | 202 |
| built-ins/Set | 92 |
| built-ins/Map | 61 |
| language/computed-property-names | 42 |
| language/destructuring | 17 |
| language/rest-parameters | 9 |

### Root cause

In `src/checker/index.ts`, the `analyzeSource` function parameter was named `analyzeOptions` but line 97 referenced it as `options`, which is undefined. This caused a runtime error "options is not defined" during compilation whenever `skipSemanticDiagnostics` was checked.

### Fix approach

Changed `options?.skipSemanticDiagnostics` to `analyzeOptions?.skipSemanticDiagnostics` on line 97 of `src/checker/index.ts`.

### Coordinates with
- #287 (generator compile errors)
- #412 (yield outside generator)

### Files to modify
- `src/checker/index.ts` -- options propagation

## Complexity: S

## Implementation Summary

**What was done:** Fixed a parameter name mismatch in `src/checker/index.ts` where `options?.skipSemanticDiagnostics` was used instead of the correct parameter name `analyzeOptions?.skipSemanticDiagnostics`. This one-line fix (commit `4446cb86`) resolved 684 compile errors across generator, async-generator, Promise, Set, Map, computed-property-names, destructuring, and rest-parameter test categories.

**What worked:** Simple parameter rename fix -- the parameter was correctly named `analyzeOptions` in the function signature and used correctly on line 45, but line 97 had a stale reference to `options`.

**Files changed:** `src/checker/index.ts` (1 line)

**Tests now passing:** Up to 684 tests that previously failed with "options is not defined" compile error.
