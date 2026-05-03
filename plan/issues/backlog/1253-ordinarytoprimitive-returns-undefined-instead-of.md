---
id: 1253
sprint: 47
title: "OrdinaryToPrimitive returns undefined instead of throwing TypeError (§7.1.1.1 step 6)"
status: done
created: 2026-04-17
updated: 2026-05-03
completed: 2026-05-03
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

- [x] `+o` throws TypeError when `o` has explicit `valueOf` AND `toString` BOTH returning non-primitives
- [x] `+{}` is NaN — Object.prototype.toString gives `"[object Object]"`, a valid primitive (no throw — this is the spec-correct baseline; the original issue's premise that `+{}` should throw was incorrect)
- [x] `String({})` and `Number(stringValue)` still work — non-object/primitive paths unaffected
- [x] No regressions in `tests/issue-1128.test.ts`, `tests/issue-997.test.ts`, `tests/issue-327.test.ts`, `tests/issue-1247.test.ts`

## Resolution (2026-05-03)

The actual bug wasn't where the issue file pointed (`src/runtime.ts:379`).
The runtime's `_toPrimitive` and `_hostToPrimitive` already implemented the
spec-correct logic: throw `TypeError` when neither valueOf nor toString of
the original object returns a primitive. The issue's example `+{}` is in
fact spec-correct as NaN (because Object.prototype.toString returns the
primitive string `"[object Object]"`).

The actual bug lives in the **static-inline fast path** in
`src/codegen/type-coercion.ts` (`coerceType` for ref→f64). When the
compiler sees an object literal with a `valueOf` field, it inlines the
call: `local.get $struct, struct.get .valueOf, ..., call_ref`. When that
inlined `valueOf` returns a non-primitive (object ref OR an externref that
wraps a JS object at runtime), the codegen used to emit `drop` +
`f64.const NaN` — bypassing both:

  - step 2.b.ii of OrdinaryToPrimitive (continue to the next method —
    `toString` — when valueOf returned non-primitive), and
  - step 3 (throw `TypeError` if neither method returns a primitive).

The fix introduces `toPrimitiveHostCallInstrs(...)` (a buffered version of
the existing `emitToPrimitiveHostCall` helper) and uses it at two sites in
the eqref-based valueOf dispatch: when the closure returns a non-f64 ref
type, AND when it returns externref. In both cases we now drop the bogus
inlined result, restore the original struct ref, and route through the
host `__to_primitive` runtime helper which re-runs valueOf, then tries
toString, and throws `TypeError` per spec when both return non-primitives.

The runtime `_toPrimitive`/`_hostToPrimitive` were not modified — they
already handled this correctly; only the static-inline shortcut was
incorrect.

Regression coverage: `tests/issue-1253.test.ts` (4 cases — `+{}` is NaN
sanity, both-non-primitive throws, valueOf returning a number works,
valueOf returning a string works).
