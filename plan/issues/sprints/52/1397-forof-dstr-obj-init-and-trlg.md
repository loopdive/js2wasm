---
id: 1397
sprint: 52
title: "for-of/dstr: obj-ptrn-id-init undefined-key + array-elem-trlg iterator close"
status: ready
created: 2026-05-09
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: triage
area: codegen, runtime
language_feature: destructuring, iteration
goal: spec-completeness
---
# #1397 — for-of/dstr remaining clusters

Follow-on triage from task #50 / PR #335 (#1396 array-OOB undefined sentinel).
Two highest-count remaining sub-clusters in `language/statements/for-of/dstr/`:

## Cluster A — obj-ptrn-id-init (~42 fails)

**Pattern**: `for (const {w = 99} of [{w: undefined}])` should fire default
because `{w: undefined}` has `w === undefined`. Per spec §13.7.5.5, defaults
fire when the value is `undefined`.

**Current behavior**: default does NOT fire. `w` ends up as a non-undefined,
non-99, non-null value (typeof check returns a string outside our
"number"/"undefined"/"object" set).

**Diagnostic probes** (all on origin/main HEAD):

```ts
// FAILS: w should be 99, but isn't
for (const {w = 99} of [{w: undefined}] as any[]) {
  // typeof w is something other than "number"/"undefined"/"object"
}

// PASSES: when key missing, default fires correctly
for (const {w = 99} of [{}] as any[]) {
  // w === 99 ✓
}

// PASSES: spec-correct null bypass (not a regression)
for (const {w = 99} of [{w: null}] as any[]) {
  // w === null ✓ (defaults fire only for undefined, not null)
}
```

**Hypothesis on root cause**: object literal `{w: undefined}` doesn't
store JS `undefined` in the externref-typed field — it stores something
else (likely `ref.null.extern` = JS null, OR a non-externref representation).
Then `__extern_get` returns that wrong value and `__extern_is_undefined`
correctly returns 0 → default doesn't fire.

**Where to investigate**:
- `compileObjectLiteral` (or wherever object literals compile) — when
  field type is externref and the property value is the `undefined`
  identifier, the emitted code should call `__get_undefined()`, not
  push `ref.null.extern`.
- The CLAUDE.md note "null/undefined in f64 context: emit
  f64.const 0 / f64.const NaN directly (avoids externref roundtrip)"
  suggests this path exists for f64; need a parallel path for
  externref that emits `__get_undefined()`.

**Same root-cause pattern as #1396** but for object-literal field
initialization rather than array-OOB destructuring.

**Estimated impact**: ~42 fails (var-/let-/const-obj-ptrn-id-init-*
subset).

## Cluster B — array-elem-trlg (~23 fails)

**Pattern**: `for ([x, ] of [iterable])` with trailing comma.
ArrayBindingPattern with elision at the end — iterator should call
`return()` after consuming the named elements.

Sample test
(`array-elem-trlg-iter-list-nrml-close.js`) uses a custom iterator
with explicit `next()` and `return()` methods. Test asserts:

- `nextCount === 1` (next called once for the bound element)
- `returnCount === 1` (return called for the trailing elision close)

**Hypothesis on root cause**: our codegen for `[x, ] of iterable` either:
1. Calls `iterator.return()` zero times (no IteratorClose emitted) —
   would show `returnCount === 0`.
2. Calls `next()` more than once (greedy iterator drain instead of
   stopping at the last bound element) — would show `nextCount > 1`.

Need to compile the test, run, and inspect actual `nextCount`/
`returnCount` values to discriminate.

**Where to investigate**:
- `compileForOfStatement` and `compileForOfDestructuring` in
  `src/codegen/statements/loops.ts` — IteratorClose emission for
  ArrayBindingPattern.
- Per ECMA-262 §13.15.5.5 (IteratorBindingInitialization for
  ArrayBindingPattern), elision elements participate in step-by-step
  iteration; trailing elision still consumes (skips) one slot, and
  abrupt completion (or normal completion at end of pattern) closes
  the iterator.
- Existing #1347 / #1348 fixes added IteratorClose for abrupt
  completion in for-of bodies; this case is the *normal* completion
  in destructuring patterns with trailing elision — separate code
  path.

**Estimated impact**: ~23 fails (`array-elem-trlg-*`).

## Acceptance criteria

1. `for (const {w = 99} of [{w: undefined}])` → `w === 99`.
2. `for (const {w = 99} of [{w: null}])` → `w === null` (regression guard).
3. `for ([x, ] of [iterable])` with custom iterator triggers
   `iterator.return()` exactly once.
4. Pre-existing for-of tests in `tests/equivalence/for-of-*.test.ts`
   continue to pass.

## Files likely touched

For Cluster A:
- `src/codegen/object-ops.ts` — object literal compilation, special-case
  `undefined` identifier values to use `__get_undefined()` for externref
  fields.

For Cluster B:
- `src/codegen/statements/loops.ts` — for-of array-pattern emission,
  ensure IteratorClose call is emitted after binding the last
  non-elision element, even when a trailing elision is present.

## Related

- #1396 (PR #335) — array-OOB undefined sentinel (parallel root cause)
- #1347 / #1348 — IteratorClose on abrupt completion (#22, #43)
- Task #52 (this triage)
