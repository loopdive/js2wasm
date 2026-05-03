---
id: 1303
sprint: 49
title: "Wasm validation: f64.trunc emitted on externref operand when compiling lodash partial.js"
status: ready
created: 2026-05-03
updated: 2026-05-03
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: type-coercion, externref
goal: npm-library-support
depends_on: []
related: [1292, 1180]
---
# #1303 — Wasm validation: `f64.trunc` operand is `externref`, not `f64`

## Background

Surfaced in #1292 (lodash Tier 2 stress test) compiling
`node_modules/lodash-es/partial.js`:

```
WebAssembly.Module(): Compiling function #94:"mergeData" failed:
f64.trunc[0] expected type f64, found global.get of type externref @+36700
```

`mergeData` (a lodash internal called from partial's HOF) emits an
`f64.trunc` whose argument is a `global.get` of an externref-typed
global. The codegen is missing an `extern.convert_any` + unbox to f64
before the trunc.

## Hypothesis

The arithmetic-on-externref code path likely:

1. Reads a captured numeric variable that was promoted to externref
   storage (because it crossed a closure boundary or got widened to
   union type)
2. Performs an integer truncation (`Math.floor` / `| 0` / spread-arg
   length probably) that the compiler maps to `f64.trunc`
3. Forgets to emit the externref→f64 unbox between the load and the
   trunc

`type-coercion.ts` has the `coerceType` helper for these conversions
(externref → f64 via `__unbox_number` import). It's not being invoked
on this code path.

## Reproduction

```bash
npx tsx -e "
import { compileProject } from './src/index.ts';
const r = compileProject('node_modules/lodash-es/partial.js', {allowJs:true});
console.log('compile success:', r.success);
new WebAssembly.Module(r.binary); // throws
"
```

## Fix scope

- Identify the codegen path for `mergeData`'s `f64.trunc` emission
- Insert `coerceType(target=f64)` before the trunc when the operand is
  externref
- Verify the same gap doesn't exist for sibling integer truncation ops
  (`f64.nearest`, `f64.floor`, `f64.ceil`, `i32.trunc_sat_*`)

## Files

- `src/codegen/expressions.ts` — `f64.trunc` emission site
- `src/codegen/type-coercion.ts` — `coerceType` helper

## Acceptance criteria

1. `compileProject('node_modules/lodash-es/partial.js')` produces a
   binary that passes `new WebAssembly.Module(...)` validation
2. Sibling truncation ops (`Math.floor`, `Math.ceil`, etc.) on externref
   operands also coerce correctly — add a focused unit test
3. No regression in #1180 (env-unbox-number rules) or Tier 1/2 stress
4. `tests/stress/lodash-tier2.test.ts` Tier 2c case can flip from
   `it.skip` to `it`
