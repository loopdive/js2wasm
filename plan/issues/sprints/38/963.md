---
id: 963
title: "Runner state leak: 412 false compile errors from CompilerPool fork contamination"
status: done
created: 2026-04-05
updated: 2026-04-14
completed: 2026-04-14
priority: critical
feasibility: hard
reasoning_effort: max
goal: async-model
required_by: [964]
---
# #963 — Runner state leak: 412 false compile errors

## Problem

412 out of 491 pass→CE files validate fine when compiled standalone but fail in the test262 runner with "invalid Wasm binary". The CompilerPool fork doesn't reset module-level compiler state between compile() calls, so state from one test (especially Promise late imports from #961) contaminates subsequent compilations.

## Evidence

Standalone validation of all 491 pass→CE files:
- 412 valid (84%) — runner false positives
- 79 invalid (16%) — genuine codegen bugs

## Root Cause

Module-scoped mutable state in the compiler survives between `compile()` calls within the same fork worker. When test N triggers Promise late import registration, the registered imports persist for test N+1, corrupting its type index space.

Known mutable state: funcTypeCache, struct type registry, import tables in CodegenContext.

## Fix

Ensure `compile()` creates a fully fresh CodegenContext with no shared mutable state from previous calls. Check all module-level caches/registries in:
- src/codegen/index.ts
- src/codegen/expressions.ts  
- src/codegen/type-coercion.ts

## Acceptance Criteria

- Standalone compile validation matches runner results (within ±5 tests)
- No false CEs from fork contamination

## Resolution (Phase 1 — #966 BUILTIN_SKIP)

The #966 fix (adding "Promise" to `BUILTIN_SKIP`) recovered ~295 CEs by preventing `collectExternDeclarations` from pre-registering Promise's `.then()` method. However, ~398 CEs remained.

## Resolution (Phase 2 — stack-balance sub-expression coercion bug)

The remaining 398 CEs were NOT a state leak — they produce identical invalid binaries in standalone mode. The root cause is a bug in `fixCallArgTypesInBody` (stack-balance.ts):

**Bug**: The backward walk from a target call (e.g. `Promise_then2`) traverses into sub-expression chains. When it finds a producer deep in a sub-expression (e.g. `new C()` which is an argument to an intermediate `method()` call), it compares the producer's type against the TARGET call's parameter types, not the INTERMEDIATE call's parameter types. An exception `|| isSafeRefToExtern` allowed `extern.convert_any` insertion even when `inSubExpr=true`, corrupting the intermediate call's argument from `ref` to `externref`.

**Example**: `new C().method().next().then($DONE, $DONE)` — the pass inserts `extern.convert_any` between `new C()` (ref) and `.method()` (expects ref_null), because Promise_then2 expects externref.

**Fix**: Removed the `|| isSafeRefToExtern` exception in `stack-balance.ts:~1663`. When `inSubExpr=true`, no coercions are applied — the producer belongs to an intermediate call, not the target call.

Also fixed `__get_globalThis` missing `shiftLateImportIndices` call in expressions.ts.

Recovered 263 of 410 remaining false CEs. 146 remaining are genuine compile errors from other issues.
