---
id: 1253
title: "OrdinaryToPrimitive returns undefined instead of throwing TypeError (§7.1.1.1 step 6)"
status: in-progress
created: 2026-04-17
updated: 2026-05-03
priority: medium
feasibility: easy
task_type: bugfix
language_feature: type-coercion
goal: error-model
depends_on: [1090]
es_edition: es5
found_by: "#1093 Phase 1 audit"
---
# #1253 — OrdinaryToPrimitive returns undefined instead of throwing TypeError

## Problem

In `src/runtime.ts:379`, the `_toPrimitive()` function returns `undefined` when neither
valueOf nor toString produces a primitive value. Per ECMA-262 §7.1.1.1 step 6, this
should **throw a TypeError** exception: "Throw a TypeError exception."

Current code:
```typescript
// line 379
return undefined;
```

Callers compensate with fallbacks:
```typescript
// line 388 — _toPrimitiveSync
return _toPrimitive(v, hint) ?? "[object Object]";
```

This means that code like `+{}` (where `{}` has neither valueOf nor toString returning
a primitive) produces `NaN` instead of throwing TypeError. Test262 tests that check for
TypeError in this scenario will fail with wrong output.

## Fix sketch

1. Change `_toPrimitive()` line 379 from `return undefined` to
   `throw new TypeError("Cannot convert object to primitive value")`
2. Update callers that use `?? fallback` patterns to use try/catch instead,
   or restructure so they check for the throw.
3. `_toPrimitiveSync` should let the TypeError propagate rather than falling
   back to `"[object Object]"`.

**Note**: This is dependent on #1090 (ToPrimitive improvements) — coordinate to avoid conflicts.

## Acceptance criteria

- [x] `+{}` throws TypeError when `{}` has no valueOf/toString returning a primitive (interpreted as: when both *do* return non-primitives — `+{}` with prototype defaults legitimately yields NaN per spec since `Object.prototype.toString` returns `"[object Object]"`)
- [x] `String({})` still returns `"[object Object]"` (toString on plain object IS the built-in)
- [x] No regressions in existing ToPrimitive tests

## Implementation

The runtime `_hostToPrimitive` already throws the right TypeError per spec
(line 640 of `src/runtime.ts`). The bug was upstream of the runtime: the
codegen's static folder `tryStaticToNumber` in
`src/codegen/expressions/misc.ts` resolved `+o` to a literal `f64.const NaN`
in three buggy paths and the Wasm body never reached `_hostToPrimitive`.

### Fix 1 — unwrap `ParenthesizedExpression` when checking arrow returns

`() => ({})` parses with body = `ParenthesizedExpression(ObjectLiteralExpression)`.
The valueOf-branch's "returns a non-primitive?" probe checked
`ts.isObjectLiteralExpression(returnExpr)` which is false for the parenthesized
form. The fix introduces an `unwrapParens` helper that strips
`ParenthesizedExpression` layers before the literal check.

### Fix 2 — toString branch must mirror the valueOf branch

The toString branch's static folder called `getStaticReturnValue`, which
recursively calls `tryStaticToNumber` on the return expression. For
`() => ({})`, the recursion hit the empty-object case and returned `NaN` —
treating "function returns an object" as if it returned the literal NaN.
The fix adds the same `ts.isObjectLiteralExpression`/`ArrayLiteralExpression`
guard as the valueOf branch, bailing to runtime so `_hostToPrimitive` can
throw TypeError per ECMA-262 §7.1.1.1 step 6.

### Fix 3 — don't fold const-traced object/array literal initializers

`const o = {}` is a const binding to a mutable object. The previous identifier
trace folded `o` to the literal `{}` and produced NaN — silently baking in the
post-init snapshot and missing sidecar mutations like
`o.valueOf = () => ({})`. The fix bails when the const initializer is an
object or array literal, forcing the runtime ToPrimitive path.

## Test Results

`tests/issue-1253.test.ts` — 11/11 pass:
- 3 acceptance-criteria tests (const-bound bad methods, empty-then-mutated, function-returned)
- 6 regression-guard tests (`+{}` → NaN, `+{valueOf:->42}` → 42, const non-object trace, string fold, NaN fold, +x with primitive const)
- 2 valueOf-falls-back-to-toString tests (`+{valueOf:->{}, toString:->'hello'}` → NaN, `→ '42'` → 42)

Cross-checked on `tests/issue-263.test.ts`, `tests/issue-287.test.ts`,
`tests/issue-1043.test.ts`, `tests/issue-1109.test.ts` — 58/58 pass.
`tests/issue-983-opaque.test.ts` and `tests/issue-866.test.ts` have
pre-existing failures on `origin/main` unrelated to this change.

The inline literal form `+{ valueOf: () => ({}), toString: () => ({}) }`
(no variable trace) still folds to `NaN` rather than throwing, because the
static fold path is only one of several routes — the inline form bypasses
the fold via the closure-call path in `coerceType` (`type-coercion.ts`
line 1599-1602 emits `f64.const NaN` directly when valueOf returns ref).
That deeper codegen path is out of scope for this issue and would need a
separate fix that integrates the runtime `_hostToPrimitive` call into the
struct-ref-to-f64 coercion when valueOf-only returns non-primitive.
