---
id: 1305
sprint: 49
title: "Module-level var init leaks externref into bitwise op codegen (legacy path)"
status: ready
created: 2026-05-03
updated: 2026-05-03
priority: medium
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: type-inference, globals, bitwise-ops
goal: npm-library-support
depends_on: []
related: [1303, 1292]
---
# #1305 — Module-level `var X = N` leaks externref into bitwise op codegen on the legacy path

## Background

While fixing #1303 (lodash `partial.js` `mergeData` failing with
`f64.trunc[0] expected type f64, found global.get of type externref`),
the IR-side defensive coercion in `src/ir/lower.ts` was insufficient
because `mergeData` compiles via the **legacy codegen path**, not the
IR path. The IR `coerceToF64ForBitwise` helper landed in #1303 but the
legacy `compileBitwiseBinaryOp` (`src/codegen/binary-ops.ts:2008`) and
the wider `compileBinaryExpression` flow still emit broken Wasm.

## Hypothesis

The legacy codegen has an externref → f64 path at
`binary-ops.ts:1295-1310` that calls `__unbox_number` before
`compileNumericBinaryOp`. It's gated on `leftType.kind === "externref" || rightType.kind === "externref"`. For lodash's
`var WRAP_BIND_FLAG = 1` reference, the gate fails to fire because:

- TypeScript types `var X = 1` as `number` (literal-init inference)
- `isNumberType(leftTsType)` is `true`, so the codepath at
  `binary-ops.ts:1255` *would* fire — except its same-line guard
  `leftType.kind !== "externref"` rejects values whose Wasm static
  type IS externref
- But somehow neither branch triggers `__unbox_number` for this case;
  the `global.get` of an externref-typed global is pushed and routed
  directly into `compileBitwiseBinaryOp` which assumes f64-on-stack

Two candidate root causes:

1. **`leftType` reported wrong**: `compileExpression` for the `Identifier`
   referencing `WRAP_BIND_FLAG` returns `{ kind: "f64" }` (matching the
   TS type) even though it pushed an externref onto the Wasm stack
   (because the global's Wasm type IS externref). Then the
   line-1295 externref guard fails to fire.
2. **Module-level `var X = N` should produce an f64 global, not externref**:
   The bug is in the global emission path — a numeric-init module-level
   `var` should be lowered to an f64 global, not externref.

(2) is the cleaner fix but a wider blast radius. (1) is a defensive
patch in `compileBinaryExpression` that mirrors the IR fix from
#1303.

## Reproduction

```bash
cd /workspace/.claude/worktrees/issue-1303-partial-f64-trunc
npx tsx -e "
import { compileProject } from './src/index.ts';
const r = compileProject('node_modules/lodash-es/partial.js', {allowJs:true});
new WebAssembly.Module(r.binary); // throws
"
```

Output:
```
WebAssembly.Module(): Compiling function #94:'mergeData' failed:
f64.trunc[0] expected type f64, found global.get of type externref @+36700
```

A reduced repro could not be derived during #1303 — straightforward
patterns like `var FLAG = 1; var BIG = 128; function check(x) { return x & (FLAG | BIG); }` validate cleanly. The lodash mergeData function is
the only known reproducer; possibly the function-graph size or the
specific interaction with `data[1] | source[1]` followed by
`newBitmask < (FLAG | KEY_FLAG | ARY_FLAG)` triggers the bug.

## Fix scope

Two layers, in order of preference:

1. **Defensive in `compileBitwiseBinaryOp` / `compileBinaryExpression`**:
   mirror the IR fix in #1303. Before the bitwise sequence, check
   the value-on-stack type via stack-balance tracking. If externref,
   emit `__unbox_number`.

2. **Root cause: module-level `var X = N` global typing**:
   audit the global-emit path. A numeric-init `var X = N` should be
   lowered to an f64 global (or a tagged-union global with f64 as
   one member, depending on whether the var is reassigned to a
   non-numeric value later in the file). Check
   `src/codegen/index.ts` global emission and the var-binding
   handling in `function-body.ts`.

## Files

- `src/codegen/binary-ops.ts` — `compileBinaryExpression`, `compileBitwiseBinaryOp`
- `src/codegen/index.ts` — module-level global emission
- `src/codegen/function-body.ts` — var-binding type inference

## Acceptance criteria

1. `compileProject('node_modules/lodash-es/partial.js')` produces a
   binary that passes `new WebAssembly.Module(...)` validation
2. `tests/stress/lodash-tier2.test.ts` Tier 2c case can flip from
   `it.skip` to `it`
3. No regression in lodash Tier 1, Tier 2 memoize/negate, equivalence
   tests
4. test262 net delta ≥ 0

## Why this matters

`partial.js` blocks Hono / koa / express middleware patterns that use
partial application. The legacy codegen path needs the same defensive
coercion as the IR path or — better — the root-cause global typing
fix that obviates both defenses.
