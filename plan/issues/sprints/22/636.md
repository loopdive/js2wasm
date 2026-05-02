---
id: 636
title: "Extract createCodegenContext() factory (fixes WASI multi-module bug)"
status: done
created: 2026-03-19
updated: 2026-04-14
completed: 2026-03-20
priority: high
feasibility: easy
goal: platform
files:
  src/codegen/index.ts:
    breaking:
      - "extract createCodegenContext() factory from generateModule/generateMultiModule"
---
# #636 — Extract createCodegenContext() factory (fixes WASI multi-module bug)

## Status: review

CodegenContext initialization is duplicated between generateModule (line ~455) and generateMultiModule (line ~694) — ~90 identical lines. generateMultiModule is missing WASI fields, silently disabling WASI for multi-file compilation.

### Fix
Extract a shared `createCodegenContext(mod, checker, options)` factory function.

## Complexity: S

## Implementation Summary

### What was done
- Extracted `createCodegenContext(mod, checker, options)` factory function that initializes all CodegenContext fields in one place, including WASI fields (`wasi`, `wasiFdWriteIdx`, `wasiProcExitIdx`, `wasiBumpPtrGlobalIdx`).
- The factory also handles common post-init steps: pre-registering vec types (`externref`, `f64`) and registering native string types when enabled.
- Refactored `generateModule` and `generateMultiModule` to call the shared factory.
- Fixed `generateMultiModule` missing: WASI field initialization, `getOrRegisterVecType` pre-registration, `registerWasiImports` call, `addWasiStartExport` call, `collectEmptyObjectWidening` calls, and `fixupStructNewArgCounts` call.
- Added unit tests for the factory function verifying field defaults and option propagation.

### Files changed
- `src/codegen/index.ts` — extracted `createCodegenContext()`, refactored both generate functions
- `tests/create-codegen-context.test.ts` — new test file (5 tests)

### What worked
- Clean extraction with no regressions (all equivalence tests pass).

### What didn't
- Nothing notable — straightforward refactor.
