---
id: 1253
title: "OrdinaryToPrimitive returns undefined instead of throwing TypeError (§7.1.1.1 step 6)"
status: ready
created: 2026-04-17
updated: 2026-04-27
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

- [ ] `+{}` throws TypeError when `{}` has no valueOf/toString returning a primitive
- [ ] `String({})` still returns `"[object Object]"` (toString on plain object IS the built-in)
- [ ] No regressions in existing ToPrimitive tests
