---
id: 1348
sprint: 50
title: "spec gap: for-of doesn't IteratorClose on body throw (portion of 389 fails)"
status: ready
created: 2026-05-08
priority: high
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: iteration
goal: spec-completeness
parent: 1328
---
# #1348 — for-of / for-await-of: IteratorClose on abrupt completion

## Problem

`language/statements/for-of`: **362 / 751 pass (48.2%) — 389 fails (304 assertion_fail,
30 runtime_error, 22 type_error, 13 null_deref, 8 other)**.
`language/statements/for-await-of`: **825 / 1234 pass (66.9%) — 409 fails (315 assertion_fail,
50 null_deref, 36 illegal_cast)**.

Spec §14.7.5 (for-of/for-in/for-await-of) requires:
1. `IteratorClose(iterator, abrupt)` must be called when:
   - The body throws.
   - The body executes `break` / `continue` to a label outside the loop.
   - The body executes `return` from the enclosing function.
2. `IteratorClose` calls `iterator.return()` and propagates errors.
3. For for-await-of: the close is awaited.

A large portion of the assertion_fail failures (estimated ~150 of 304) check that the iterator's
`.return()` was called with a specific value when the body throws.

## Acceptance criteria

1. `language/statements/for-of/iterator-close-throw-error.js` passes.
2. `language/statements/for-of/iterator-close-via-break.js` passes.
3. `language/statements/for-of/iterator-close-via-return.js` passes.
4. `language/statements/for-await-of/iterator-close-throw-error.js` passes.
5. Pass-rate for `language/statements/for-of` rises from 48% to ≥75%.

## Files to modify

- `src/codegen/statements.ts` — `compileForOfStatement`, `compileForAwaitOfStatement`
- `src/codegen/expressions.ts` — exception-region setup around for-of body

## Implementation Plan

### Root cause

The for-of body is currently emitted as a plain Wasm loop without a try/catch around it.
When the body throws, control flows directly out of the loop — the iterator's `.return()` is
never called. Spec requires the loop to be wrapped in a try-catch that catches any abrupt
completion, calls `IteratorClose`, then re-raises.

### Approach

```wasm
;; Pseudocode for compileForOfStatement
local.set $iter
loop $body
  ;; Call iter.next()
  local.get $iter
  call $__iterator_next
  ...
  ;; Bind binding to value
  ;; ─── BEGIN body try block ───
  try_table $loop_close
    <body>
    br $body
  end
  ;; ─── END body — handler ───
  ;; Body threw or break/return — call IteratorClose
  local.get $iter
  call $__iterator_close
  rethrow $exn
end loop
```

For `break`/`continue` to outer label and `return`, intercept the same way: emit a
finally-style cleanup that runs IteratorClose before the actual jump.

For for-await-of: the IteratorClose must be `await`-ed; this requires inserting a yield-suspend
point in the cleanup path.

### Edge cases

- Iterator without `.return()` — IteratorClose is a no-op.
- `.return()` itself throws → re-raise the new error (replacing the original per spec
  §7.4.6 IteratorClose step 6).
- `break` to a label that's still inside the loop body — no close needed.

### Test262 sample

- `test262/test/language/statements/for-of/iterator-close-throw-error.js`
- `test262/test/language/statements/for-of/iterator-close-via-break.js`
- `test262/test/language/statements/for-await-of/iterator-close-throw-error.js`
