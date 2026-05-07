---
id: 1340
sprint: 50
title: "spec gap: AggregateError + SuppressedError errors-iterable + cause coercion (37 test262 fails)"
status: ready
created: 2026-05-08
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: runtime, codegen
language_feature: error
goal: spec-completeness
parent: 1328
---
# #1340 — AggregateError / SuppressedError: errors iterable, cause option

## Problem

`built-ins/AggregateError`: **4 / 25 pass (16.0%)** — 9 type_error, 5 assertion_fail, 5 runtime_error,
2 illegal_cast.
`built-ins/SuppressedError`: **6 / 22 pass (27.3%)** — 10 type_error, 4 assertion_fail, 2 illegal_cast.

Spec §20.5.7 (AggregateError) requires:
1. Constructor `AggregateError(errors, message, options)` calls `IteratorToList(errors)` — must
   accept any iterable (Array, Set, custom iterator).
2. `errors` property: a frozen Array of the iterated errors.
3. `cause` is set from `options.cause` if `options` has it (`HasProperty`, not just truthy).
4. `message` is coerced to string only if defined.

Spec §20.5.10 (SuppressedError) requires similar: `SuppressedError(error, suppressed, message, options)`,
all 4 args validated, options.cause handled.

The 9 + 10 type_error counts indicate our constructor throws on inputs it should accept (likely
fails when `errors` is not an Array but is iterable — e.g. Set or generator).

## Acceptance criteria

1. `built-ins/AggregateError/errors-iterabletolist.js` passes.
2. `built-ins/AggregateError/properties-of-error-objects.js` passes.
3. `built-ins/SuppressedError/constructor-properties.js` passes.
4. Pass-rate for `built-ins/AggregateError` rises from 16% to ≥70%; SuppressedError from 27% to ≥70%.

## Files to modify

- `src/runtime.ts` — `__construct_aggregate_error`, `__construct_suppressed_error`
- `src/codegen/registry/errors.ts` (or wherever Error constructors are registered)

## Implementation Plan

### Root cause

The AggregateError constructor wrapper currently calls `Array.isArray(errors)` and throws TypeError
otherwise. Spec actually requires `IteratorToList(GetIterator(errors))` — must accept Set, Map,
generators, custom iterables.

### Approach

```javascript
// __construct_aggregate_error pseudo-code
function constructAggregateError(errors, message, options) {
  // §20.5.7.2 step 4: errorsList = IteratorToList(GetIterator(errors))
  if (errors == null) throw TypeError("errors must be iterable");
  const errorsList = Array.from(errors); // host-import path
  // §20.5.7.2 step 5: O = OrdinaryCreateFromConstructor(...)
  // step 6: install errors as a frozen array
  // step 7: install message if defined
  // step 8: InstallErrorCause(O, options) — only if options.cause exists
  ...
}
```

Mirror for SuppressedError.

### Edge cases

- `errors` argument is null/undefined → TypeError ("not iterable").
- options is non-object → silent skip (not an error).
- options.cause is `undefined` but the property exists → still install (spec uses HasProperty).

### Test262 sample

- `test262/test/built-ins/AggregateError/errors-iterabletolist.js`
- `test262/test/built-ins/SuppressedError/cause.js`
