---
id: 1252
title: "SameValue for DefineProperty f64 comparison uses f64.ne — wrong for NaN and ±0"
status: done
created: 2026-04-17
updated: 2026-04-28
priority: medium
feasibility: easy
task_type: bugfix
language_feature: object-model
goal: error-model
es_edition: es5
found_by: "#1093 Phase 1 audit"
---
# #1252 — SameValue for DefineProperty f64 comparison uses f64.ne — wrong for NaN and ±0

## Problem

In `src/codegen/object-ops.ts:879-881`, the DefineProperty "is value unchanged?" check uses
`f64.ne` to compare old and new values. Per ECMA-262 §9.1.6.3 step 7, the comparison must
use **SameValue** (§7.2.10), which differs from `f64.ne` in two ways:

1. **NaN**: `SameValue(NaN, NaN)` is **true** (values are the same), but `f64.ne(NaN, NaN)` returns 1
   (not equal). So redefining a frozen property that already holds NaN with NaN will incorrectly
   throw TypeError.

2. **±0**: `SameValue(+0, -0)` is **false** (different values), but `f64.ne(+0, -0)` returns 0
   (equal). So redefining a frozen property from +0 to -0 will silently succeed instead of throwing.

The code has a comment acknowledging this: "Note: f64.ne treats NaN != NaN (not SameValue),
but sufficient for typical test262 cases"

## Fix sketch

Replace `f64.ne` with a proper SameValue comparison for f64:

```
;; SameValue(a, b) for f64:
;; (a == b && copysign(1,a) == copysign(1,b)) || (a != a && b != b)
local.get $old
local.get $new
f64.eq           ;; a == b (handles most cases, but +0 == -0)
local.get $old
f64.const 1.0
f64.copysign     ;; copysign(1, old) — gives sign
local.get $new
f64.const 1.0
f64.copysign     ;; copysign(1, new) — gives sign
f64.eq           ;; same sign?
i32.and          ;; a==b AND same sign (distinguishes +0/-0)
local.get $old
local.get $old
f64.ne           ;; isNaN(old)
local.get $new
local.get $new
f64.ne           ;; isNaN(new)
i32.and          ;; both NaN
i32.or           ;; SameValue result
```

Then the throw condition is: `if (!sameValue) throw TypeError`.

## Acceptance criteria

- [x] `Object.defineProperty` on a frozen object with NaN value accepts NaN reassignment
- [x] `Object.defineProperty` on a frozen object with +0 rejects -0 reassignment
- [x] test262 tests for `Object.defineProperty` SameValue semantics pass

## Resolution

PR #182 (#1127) introduced the SameValue scaffold but with the operands of
`f64.copysign` reversed. The Wasm op `f64.copysign(x, y)` returns x with the
sign of y, so `copysign(value, 1)` always produces `abs(value)` — the magnitude
of value, with the positive sign. To extract just the sign of a value (for
distinguishing +0 from -0), we need `copysign(1, value)` — magnitude 1 carrying
the sign of value.

In Wasm stack order this means: push 1, then push value, then `f64.copysign`
pops y=value first and x=1 second, yielding `copysign(1, value) = ±1`. The
original code pushed value first and 1 second, so the comparison's "sign
extraction" branch always produced `+abs(value) == +abs(value)`, which is
trivially true for any +0/-0 pair. The NaN === NaN path was unaffected (it
uses `f64.ne(x, x)`, no copysign).

Fix swaps the two pushes in `src/codegen/object-ops.ts`:

```ts
// before: copysign(value, 1) = abs(value)
fctx.body.push({ op: "local.get", index: oldValLocal });
fctx.body.push({ op: "f64.const", value: 1.0 });
fctx.body.push({ op: "f64.copysign" });

// after: copysign(1, value) = ±1
fctx.body.push({ op: "f64.const", value: 1.0 });
fctx.body.push({ op: "local.get", index: oldValLocal });
fctx.body.push({ op: "f64.copysign" });
```

Same swap for the `newValLocal` half of the SameValue check.

## Test Results

- `tests/issue-1252.test.ts`: 8/8 pass — covers +0/-0 distinction via `0 * -1`,
  `1 / -Infinity`, both directions of swap, plus regression guards for
  same-+0, same--0, distinct positives, and distinct signs.
- `tests/issue-1127-samevalue.test.ts` (NaN regression guard): 3/3 pass.
- `tests/define-property-patterns.test.ts`: passes.

(`tests/object-define-property.test.ts` and
`tests/object-define-property-accessors.test.ts` fail to load on main with
a missing `./helpers.js` import — pre-existing infrastructure issue
unrelated to this fix.)
