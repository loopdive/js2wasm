---
id: 1347
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
# #1347 — for-of / for-await-of: IteratorClose on abrupt completion

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

## Implementation (dev-a)

Surveyed the existing for-of pipeline and the failing tests. Findings:

- The throw-path try/catch_all + the break/continue/return finallyStack
  cleanup are ALREADY in `compileForOfIterator` (#851). Simple
  `iterator-close-via-throw.js`, `iterator-close-via-break.js`,
  `iterator-close-via-continue.js` already pass.
- The 389 fails are heterogeneous: most are destructuring edge cases
  (`dstr/...`), harness wrapping issues (return-from-IIFE inside for-of),
  or downstream Object.create / Function.bind gaps — not the simple
  IteratorClose flow.
- ONE clear close-protocol gap: the runtime's `__iterator_return`
  swallowed the case where `iterator.return` was non-null but
  non-callable (e.g. `return: 1`). Per ES §7.4.6 IteratorClose +
  §7.3.11 GetMethod step 4, that should throw TypeError.

Two-part fix in this PR:
1. **Runtime** (`src/runtime.ts`) — `__iterator_return` now throws
   `TypeError("Iterator return method is not callable")` when `iter.return`
   is non-null and non-callable. Functions and WasmGC closures continue
   to be invoked; null/undefined remain a no-op (GetMethod step 3).
2. **Compiler** (`src/codegen/statements/loops.ts`) — the throw-path
   `catchAll` wraps its `__iterator_return` call in a nested
   try/catch_all so any error from IteratorClose is dropped before
   `rethrow 0` re-raises the ORIGINAL exception. Per spec §7.4.6
   step 6, when the outer completion is throw, IteratorClose's error
   is suppressed. The break/continue/return paths (via `finallyStack`
   cloned body) call `__iterator_return` directly, so any TypeError
   from a non-callable `return` propagates to the caller (step 7).

The architect's edge-case note "If `.return()` itself throws → re-raise
the new error" matches **break/continue/return** semantics. For
**throw** the spec is the opposite — original error wins. The fix
applies that distinction correctly.

Full fix for the 389-fail wave will require separate issues for the
destructuring edge cases, harness wrapping, and downstream gaps.

## Test Results

`tests/issue-1347.test.ts` — 5 tests, all pass:

- close-by-throw with non-callable return → original throw wins
- close-by-break with non-callable return → TypeError propagates
- regression: callable return called once on break
- regression: missing return method is a no-op
- regression: throw-path with callable return that throws → original wins

Existing iterator/close suites pass: `issue-851.test.ts` (5 tests),
`issue-859.test.ts` (8 tests). Pre-existing failures in
`for-of-array-destructuring.test.ts` and `for-of-generator.test.ts`
are unrelated module-resolution errors (missing `./helpers.js`),
not regressions from this fix.
