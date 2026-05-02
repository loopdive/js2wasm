---
id: 1260
title: "Destructuring of null/undefined must throw TypeError per §13.15.5.5"
status: review
created: 2026-05-02
updated: 2026-05-02
priority: high
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: destructuring
goal: test-infrastructure
related: [1177, 1245, 1225]
depends_on: []
test262_fail: 10
---

# #1260 — Destructuring `null` / `undefined` must throw TypeError

## Background

This issue was identified during the #1245 investigation of why PR#125 / PR#155
landed with 81 real regressions. It is a **pre-existing spec-bug** that is
masked on main today by the wrong-slot read in #1177 cap-prepend; once Stage 1
reads the right slot, the bug surfaces directly.

## Problem

ECMA-262 §13.15.5.5 (`PropertyDestructuringAssignmentEvaluation` →
`RequireObjectCoercible`) and §13.15.5.4 (`IteratorDestructuringAssignment`)
both require a `TypeError` when the source of a destructure is `null` or
`undefined`:

```js
[a] = null;          // TypeError (not iterable)
({ a } = null);      // TypeError (RequireObjectCoercible)
[[a]] = [null];      // inner element is null → TypeError on inner destructure
```

Our codegen path for assignment-form destructuring does not consistently emit
the spec-mandated throw — instead, the wrapped function relied on a downstream
property access throwing on the null receiver. With the right-slot read post
Stage 1, the source flows correctly through (e.g., as a `null`/`undefined`
externref) and the destructure proceeds without the spec-mandated throw.

## Canonical reproductions (test262)

- `language/expressions/assignment/dstr/array-elem-nested-array-null.js` —
  `[[ _ ]] = [null]` expects TypeError; we silently iterate null.
- `language/expressions/assignment/dstr/array-elem-nested-array-undefined-hole.js` —
  `[[ _ ]] = [ , ]` (hole-iterated as undefined) expects TypeError.
- `language/expressions/assignment/dstr/obj-prop-nested-array-undefined-own.js` —
  `{ x: [ x ] } = { x: undefined }` expects TypeError.
- `language/statements/for-of/dstr/array-elem-nested-obj-null.js` —
  `for ([{ x }] of [[null]])` expects TypeError per iteration element.
- `language/statements/for-of/dstr/obj-rest-val-null.js` —
  `for ({...rest} of [null])` expects TypeError.
- `language/expressions/class/dstr/gen-meth-static-dflt-obj-ptrn-prop-obj-value-null.js`
- `language/expressions/class/dstr/meth-static-dflt-obj-ptrn-prop-obj-value-null.js`
- `language/statements/class/dstr/meth-dflt-obj-ptrn-prop-obj-value-null.js`
- `language/statements/class/dstr/gen-meth-dflt-obj-ptrn-prop-obj-value-null.js`
- `language/statements/class/dstr/meth-static-dflt-obj-ptrn-prop-obj-value-null.js`

## Existing infrastructure

#1225 added `emitExternrefDestructureGuard` (loops.ts) which emits a
runtime null-check + TypeError for the for-of element destructure case. The
guard fires when we destructure a top-level loop element that is null/undefined.

What's missing:

1. **Nested destructure source guards.** When `[[ _ ]] = [null]` decomposes
   to inner-pattern `[ _ ]` over the inner element `null`, the inner step
   does not call the guard.
2. **Object-source RequireObjectCoercible.** The `{ x } = null` path needs a
   parallel guard before the property-access decomposition.
3. **Default-value-with-null branch.** The architect path
   `compileForOfAssignDestructuringExternref` line ~1564 has a `defaultInit`
   branch that elides the guard when a default is provided — fix to still
   guard the SOURCE even when the inner has a default (the spec applies the
   default only when the property is `undefined`, not when the source is
   `null`).

## Fix sketch

1. Audit destructuring entry points:
   - `compileObjectDestructuring` — parallel of array path
   - `compileForOfAssignDestructuringExternref` — already wired for top-level
   - `compileForOfAssignDestructuring` (tuple branches) — likely already OK
     since tuple structs cannot be null
   - `compileArrayLiteralAssignment` (in expressions/assignments)
2. Hoist `emitExternrefDestructureGuard` to fire on EVERY nested pattern
   source, not just the top-level loop element.
3. For object-source guards, add `emitExternrefRequireObjectCoercible(ctx, fctx, srcLocal)`
   that throws TypeError on null/undefined.
4. Apply guards before any default-value branch — defaults trigger on
   `undefined` *property*, not on `null`/`undefined` *source*.

## Acceptance criteria

1. The 10 named test262 cases pass.
2. Equivalence test added: `tests/issue-1260.test.ts` covering:
   - `[[a]] = [null]` → TypeError
   - `({ x: [ x ] } = { x: undefined })` → TypeError
   - `for ([[ x ]] of [[null]])` → TypeError per iteration element
3. No regressions on positive destructuring tests.
4. After this AND #1258, #1259 land, #1177 Stage 1 should re-land cleanly.

## Out-of-scope

- Custom iterator close-on-abrupt for nested destructure (covered by #1219).
- Object-rest with non-coercible (`{...rest} = undefined`) — same fix
  surface; cover only if trivial extension.

## Related

- #1177 — TDZ propagation (Stage 1 blocked on this)
- #1225 — emitExternrefDestructureGuard (top-level loop element)
- #1245 — Investigation finding

## Implementation summary

Patched `src/codegen/expressions/assignment.ts` with two targeted fixes:

1. **`emitObjectDestructureFromLocal`** — when the source struct of an
   object destructure is statically `ref T` (non-nullable) but the runtime
   value can be null (e.g. `[{x}] = [null]`: `[null]` is typed `null[]`,
   element-extracted as ref but the runtime value is null), the previous
   guard at line 1492 was gated on `srcType.kind === "ref_null"` and
   silently skipped for `ref`. struct.get on the null reference produced
   a Wasm null_deref instead of the spec-required TypeError. Fix: widen
   the source local to nullable via `widenLocalToNullable` and always emit
   the `ref.is_null` → throw guard for non-empty patterns. Mirrors the
   pre-existing widening in `emitArrayDestructureFromLocal` (#1225).

2. **`compileDestructuringAssignment` no-struct fallback** — when the RHS
   of `({...} = expr)` is externref / `ref_null` and no struct type can
   be resolved, the previous fallback only checked `ref.is_null`,
   silently allowing JS-undefined sentinels through (per §13.15.5.5
   RequireObjectCoercible, both null AND undefined must throw). Fix:
   route externref through `emitExternrefAssignDestructureGuard` which
   emits both `ref.is_null` AND `__extern_is_undefined` checks.

`tests/issue-1260.test.ts` covers 7 cases:
- `[{x}] = [null]` (typed-array path, was null_deref → now TypeError)
- `[{x}] = [null]` with `any[]` (externref path)
- `[[a]] = [null]` (regression sanity — already worked)
- `[[_]] = [,]` (sparse hole = undefined → TypeError)
- `({x: [x]} = {x: undefined})` (object source, undefined property)
- Regression sanity: non-null `[a, b] = [10, 20]`
- Regression sanity: nested `[{x: a}, {y: b}] = [{x:1}, {y:2}]`

The test262 case `array-elem-nested-obj-null.js` (assignment-expression
form) now passes — previously failed with `dereferencing a null pointer`
instead of TypeError.

## Out-of-scope (deferred follow-ups)

Identified during investigation but left for separate issues (the
ref/ref_null encoding cannot distinguish JS null from undefined in
struct fields, requiring runtime infrastructure changes):

- **`emitNestedBindingDefault` ref/ref_null path** (destructuring.ts:215)
  — when a function param has shape `{w: {x,y,z} = D}` and is called with
  `{w: null}`, the default branch fires on `ref.is_null` (treating both
  null and undefined as triggers). Per spec, default fires only on
  undefined; null should throw TypeError. Affects ~5 test262 cases:
  - `expressions/class/dstr/gen-meth-obj-ptrn-prop-obj-value-null.js`
  - `expressions/object/dstr/gen-meth-obj-ptrn-prop-obj-value-null.js`
  - `expressions/object/dstr/async-gen-meth-obj-ptrn-prop-obj-value-null.js`
  - `statements/class/dstr/gen-meth-obj-ptrn-prop-obj-value-null.js`

- **For-of typed-struct path with nested array/object property targets**
  (loops.ts:1181-1230) — `for ({x: [x]} of [{x: undefined}])` doesn't
  dispatch on nested array/object property initializers; only handles
  identifier targets. Affects ~2 for-of test262 cases.
