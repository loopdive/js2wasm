---
id: 1292
sprint: 48
title: "lodash Tier 2 stress test — memoize, flow, partial application"
status: in-progress
created: 2026-05-03
updated: 2026-05-03
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: npm-package-imports, closures, higher-order-functions
goal: npm-library-support
depends_on: [1291]
related: [1278, 1276, 1279]
---
# #1292 — lodash Tier 2 stress test: memoize, flow, partial application

## Background

Lodash Tier 1 covers identity, add, and clamp at the function-compilation level.
Tier 2 exercises patterns that require:
- **memoize**: closures over a `Map`-backed cache (WeakMap variant covered by #1242)
- **flow / flowRight**: function composition via reduce over an array of functions
- **partial / partialRight**: partial application via closure capture of arguments
- **curry**: variadic arity tracking via closure

These patterns exercise HOF composition, closure capture depth, and typed-array
iteration — all areas recently improved in S47 (#1276, #1281, #1280).

## Acceptance criteria

Write `tests/stress/lodash-tier2.test.ts` covering:

1. **memoize (simple)** — `_.memoize(fn)` where `fn: (n: number) => number`.
   Call twice with same arg, assert result identical and `fn` only called once
   (call-count sentinel).

2. **flow** — `_.flow([fn1, fn2, fn3])` where each `fn: (n: number) => number`.
   Assert `flow(1)` equals `fn3(fn2(fn1(1)))`.

3. **partial** — `_.partial(fn, a)` produces a function that calls `fn(a, ...rest)`.
   Assert `partial(2)(3) === fn(2, 3)`.

4. **negate** — `_.negate(pred)` returns `!pred(x)`. Simple boolean flip.

Each tier must:
- Compile the lodash-es module (`compileProject`)
- Instantiate the Wasm module
- Call the exported function with a concrete argument
- Assert the return value matches the expected JS behavior

If any tier fails at compile or instantiate, mark with `it.skip` and an issue ref
(don't block the others).

## Files

- `tests/stress/lodash-tier2.test.ts` (new)
- `plan/issues/sprints/48/1292-lodash-tier2-stress-test.md` — this file

## Notes

- Tier 2 is not about making all of lodash work — it's a probe for specific
  compilation patterns. Each failing tier is a bug report, not a blocker.
- `_.memoize` uses `Map` internally (not `WeakMap`). If `Map` iteration fails,
  document the gap.
- `_.flow` with a typed `fn[]` array exercises IR Array methods (#1233).

## Test Results (2026-05-03)

`tests/stress/lodash-tier2.test.ts` — 5 cases total, 2 pass + 3 skip
(stress-test scope only — gaps documented as follow-up issues, not fixed
inline).

### Tier 2a — memoize ✓ (compile path), ⏳ (instantiate)

- ✓ `compileProject` succeeds, binary validates
- ✓ Wasm exports `memoize` and `default` as functions
- ✓ Every Wasm import is satisfied by `buildImports` (none missing)
- ⏳ Instantiation throws `WebAssembly.Exception` from start function —
  same gap as Tier 1's clamp/add (lodash transitive feature-detection
  init throws). Tracked under #1295 on the start-function side.

### Tier 2b — flow ✗ (Wasm validation fails) → **#1302**

```
Compiling function #945:"__closure_837" failed:
Invalid global index: 266 @+117088
```

`compileProject` succeeds, but `new WebAssembly.Module(...)` rejects
because `__closure_837` references a global slot past the declared
range. Likely closure-env / global-index allocation bug for modules
with hundreds of closures. Filed as #1302.

### Tier 2c — partial ✗ (Wasm validation fails) → **#1303**

```
Compiling function #94:"mergeData" failed:
f64.trunc[0] expected type f64, found global.get of type externref @+36700
```

Codegen emits `f64.trunc` on an externref operand without unboxing.
`coerceType` (in `type-coercion.ts`) is missing on this code path.
Filed as #1303.

### Tier 2d — negate ✓ (compile + instantiate), ⏳ (call from JS) → **#1304**

- ✓ `compileProject` succeeds, validates, instantiates (no start-function
  exception — negate has no transitive feature-detection deps)
- ✓ Exports `negate` and `default` as functions
- ⏳ Calling `negate(jsPredicate)` throws lodash's own `TypeError:
  Expected a function`: the compiled `typeof predicate != 'function'`
  guard receives an externref-wrapped JS callable and classifies it
  as `"object"`, not `"function"`. Filed as #1304 (related to existing
  #1275 typeof-guard-narrowing).

### Stress-test ladder progression

| Tier | Compile | Validate | Imports | Instantiate | Callable | Status |
|------|---------|----------|---------|-------------|----------|--------|
| 1 identity | ✓ | ✓ | ✓ | ✓ | ✓ | full pass |
| 1 clamp | ✓ | ✓ | ✓ | ✗ #1295 | — | start-fn gap |
| 1 add | ✓ | ✓ | ✓ | ✗ #1295 | — | start-fn gap |
| 2 memoize | ✓ | ✓ | ✓ | ✗ #1295 | — | start-fn gap |
| 2 flow | ✓ | ✗ #1302 | — | — | — | validation gap |
| 2 partial | ✓ | ✗ #1303 | — | — | — | validation gap |
| 2 negate | ✓ | ✓ | ✓ | ✓ | ✗ #1304 | call-surface gap |

negate is the furthest any lodash module has progressed in the ladder.

### Filed follow-up issues (stress-test scope — not fixed inline)

- **#1302** — flow.js: closure references invalid global index past
  declared range
- **#1303** — partial.js: f64.trunc emitted on externref operand without
  coerceType
- **#1304** — typeof externref-wrapped JS function returns `"object"`
  instead of `"function"`
