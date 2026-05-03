---
id: 1304
sprint: 49
title: "typeof on externref-wrapped JS function returns 'object' instead of 'function'"
status: in-progress
created: 2026-05-03
updated: 2026-05-03
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: runtime
language_feature: typeof, externref, functions
goal: npm-library-support
depends_on: []
related: [1292, 1275, 1248]
---
# #1304 — `typeof predicate != 'function'` mis-classifies externref-wrapped JS callable

## Background

Surfaced in #1292 (lodash Tier 2 stress test) calling the compiled
`negate(predicate)` from JS:

```
TypeError: Expected a function
  at member (src/runtime.ts:1587:18)
  at fn (src/runtime.ts:4243:27)
  at negate (wasm://wasm/8147e4ae:wasm-function[10]:0x53e)
```

lodash's `negate.js` does an explicit guard:

```js
function negate(predicate) {
  if (typeof predicate != 'function') {
    throw new TypeError(FUNC_ERROR_TEXT);
  }
  // ...
}
```

When called from JS as `exports.negate(jsFn)`, the JS function arrives
in Wasm as an externref. The compiled `typeof` operation classifies
that externref as `"object"` rather than `"function"`, so the guard
fires and lodash's TypeError is thrown.

## Hypothesis

`runtime.ts` `typeof_extern` (or the inlined codegen for `typeof x`) has
a branch table for externref classification. JavaScript's spec for
`typeof fn` returns `"function"` only when the value's
`[[IsCallable]]` slot is true. The current implementation likely:

1. Checks for `null` → `"object"` ✓
2. Checks for boxed-number / boxed-string / boxed-bool → those types
3. Falls back to `"object"` for everything else (including callables)

The fix is to add a callable check (likely via host import that does
`typeof x === 'function'` on the JS side and returns a sentinel) before
the fallback.

## Reproduction

```bash
npx tsx -e "
import { compileProject } from './src/index.ts';
import { buildImports } from './src/runtime.ts';
const r = compileProject('node_modules/lodash-es/negate.js', {allowJs:true});
const imps = buildImports(r.imports, undefined, r.stringPool);
const inst = await WebAssembly.instantiate(r.binary, imps);
try {
  const negated = inst.instance.exports.negate((n) => n % 2 === 0);
  console.log('OK:', negated);
} catch (e) {
  console.log('ERR:', e.message); // 'undefined' (Wasm Exception)
  if (e instanceof WebAssembly.Exception) {
    console.log('payload:', e.getArg(inst.instance.exports.__exn_tag, 0));
    // → TypeError: Expected a function
  }
}
"
```

## Fix scope

- Audit `typeof_extern` (or inline codegen path) for the function
  classification branch
- Add a host import that returns `1` if the JS value is callable, `0`
  otherwise; route that through the `typeof` codegen
- Or: tag externref-wrapped functions at the WrapFn import site so the
  classifier can read the tag without a host call

## Files

- `src/runtime.ts` — `typeof_extern` (around line 1587)
- `src/codegen/expressions.ts` — `typeof x` emission for externref operand

## Acceptance criteria

1. `typeof jsFunctionAsExternref` returns `"function"` from compiled
   Wasm
2. lodash `negate(jsFn)` returns a callable closure that flips the
   predicate's boolean
3. `tests/stress/lodash-tier2.test.ts` Tier 2d-call case can flip from
   `it.skip` to `it`
4. No regression in #1275 (typeof guard narrowing) or #1248 (typeof
   string guard)
5. test262 net delta ≥ 0

## Why this matters

Almost every reasonable JS library does typeof guards on function
arguments. Without correct externref→function classification, the JS
host cannot pass a callback into Wasm — a hard limit on practical
interop.

## Root cause (2026-05-03)

The bug is NOT in the runtime `__typeof_function` host import — that
function correctly returns `1` for callable JS values. The bug is at
*compile time* in `staticTypeofForType`
(`src/codegen/typeof-delete.ts`).

When TypeScript compiles `lodash-es/negate.js`, it infers the type of
the `predicate` parameter as the global `Function` interface (because
the function body uses `predicate.call(this, ...)` and
`predicate.apply(this, args)`). `staticTypeofForType` checks for the
`String/Number/Boolean` wrapper symbol names but does NOT check for
`Function` — so the type falls through to the externref/Object branch
which returns `"object"`.

The compiled `if (typeof predicate != 'function')` then folds at
compile time:
- `staticTypeof = "object"` (wrong)
- `stringLiteral = "function"`
- `matches = false` → `result = isNeq ? 1 : 0` = `1`

The compiler emits `i32.const 1` for the if condition, so the
`throw new TypeError(...)` runs unconditionally on every call.

Fix: add a `Function` symbol check in the `Object` flag branch that
returns `"function"` directly, mirroring the existing
`String/Number/Boolean` wrapper logic.

## Test Results

`tests/issue-1304.test.ts` — 5/5 pass:
- typeof === 'function' on a JS function passed as externref
- typeof !== 'function' is false for a JS function
- typeof === 'object' on a plain object
- typeof === 'number' on a JS number
- Function-typed param doesn't fold typeof guard to always-throw
  (lodash negate idiom — captures the original repro)

End-to-end with lodash:
- `compileProject('lodash-es/negate.js', {allowJs:true})` previously
  threw `TypeError: Expected a function` on every call. After fix,
  `negate(jsFn)` returns the wrapped negated callable.

Regression check: identical pass/fail counts to main on
`tests/typeof-comparison.test.ts`, `tests/typeof-expression.test.ts`,
`tests/typeof-member-expression.test.ts`, `tests/null-narrowing.test.ts`,
`tests/union-narrowing.test.ts`. Hono Tier 1-5 + lodash Tier 1 stress
tests: 35/35 active pass (4 unrelated skipped) — no regressions.
