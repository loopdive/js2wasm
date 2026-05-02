---
id: 966
title: "79 genuine invalid Wasm binaries from static private fields + Promise arity"
status: done
created: 2026-04-05
updated: 2026-04-14
completed: 2026-04-14
priority: high
feasibility: medium
reasoning_effort: high
goal: async-model
---
# #966 — 79 genuine invalid Wasm binaries

## Problem

79 files produce genuinely invalid Wasm (fail standalone validation, not runner state leak).

Two patterns:
- **Static private fields** (~60): `extern.convert_any[0] expected type anyref, found call of type...` in functions like C_$, C_x, C___priv_x — type mismatch when accessing private class fields
- **Promise call arity** (~19): `not enough arguments on the stack for call (need 3, got 2)` in __module_init and __cb_N — Promise.then() late import registered with wrong function signature

## Acceptance Criteria

- All 79 files produce valid Wasm
- No extern.convert_any type mismatches on private fields
- Promise late import function signatures match expected arity

## Implementation

**Pattern 1 — static private field via `this` in static method** (`src/codegen/property-access.ts`):
When `this` is used in a static method context (no `this` local in `fctx.localMap`), detect it before the general property-access path and look up the static global directly via `ctx.staticProps`, emitting `global.get`. Previously fell through to `__extern_get` fallback which wraps with `extern.convert_any`, requiring `anyref` but receiving `externref` from `emitUndefined()`.

**Pattern 2 — Promise arity mismatch** (`src/codegen/index.ts`):
Added "Promise" to `BUILTIN_SKIP` set in `collectExternDeclarations`. When `Error` (a LIB_GLOBAL) is in source, all lib files are scanned and TypeScript's merged `Promise` symbol declarations include 4 `interface Promise<T>` declarations with `then(onfulfilled?, onrejected?)` — collected as a 3-param Wasm function. The dedicated Promise handler uses a 2-param `ensureLateImport`, creating arity mismatch. Skipping Promise in `collectExternDeclarations` prevents the pre-registration conflict.

## Test Results

- 8/8 new tests pass (`tests/issue-966.test.ts`)
- Pattern 1: `this.#x` in static method returns correct value; anonymous class variant produces valid Wasm
- Pattern 2: `Promise_then` registered as builtin (2-param) not extern_class (3-param); all `.then()` variants produce valid Wasm
- Broad scan: 0 remaining `extern.convert_any` type mismatch errors (500+ test262 files checked)
- Broad scan: 0 remaining `need 3, got 2` arity errors (150 async/class files checked)
- Equivalence regressions: none (all pre-existing failures, verified against main)
