---
id: 851
title: "Iterator close protocol not implemented (147 tests)"
status: done
created: 2026-03-28
updated: 2026-04-14
completed: 2026-04-14
priority: high
feasibility: medium
reasoning_effort: high
goal: async-model
test262_fail: 147
---
# #851 -- Iterator close protocol not implemented (147 tests)

## Problem

147 tests fail because the iterator close protocol is not correctly implemented. When an abrupt completion (throw, break, return) occurs during iteration, the `return()` method on the iterator should be called. Our compiler does not call `return()` on iterators in these cases.

Error messages: "abrupt completion closes iter" (124 tests), "completion closes iter" (21 tests), "Generator must not be resumed" (2 tests).

### Sample files with exact errors and source

**1. yield* getiter async get abrupt**
File: `test/language/expressions/async-generator/named-yield-star-getiter-async-get-abrupt.js`
Error: `abrupt completion closes iter`
```js
// The test verifies that when getting [Symbol.asyncIterator] throws,
// the sync iterator's return() method is called (iterator close protocol).
var obj = {
  get [Symbol.asyncIterator]() { throw reason; },
  [Symbol.iterator]() { return iter; }
};
// yield* should close the sync iterator when async iterator access fails
```
Root cause: `yield*` does not close the fallback sync iterator when async iterator access fails.

**2. yield* async not callable throw**
File: `test/language/expressions/async-generator/named-yield-star-getiter-async-not-callable-boolean-throw.js`
Error: `abrupt completion closes iter`
Root cause: When `Symbol.asyncIterator` is a non-callable value (boolean), the iterator close protocol should fire.

**3. yield* async returns abrupt**
File: `test/language/expressions/async-generator/named-yield-star-getiter-async-returns-abrupt.js`
Error: `abrupt completion closes iter`

**4. for-of break should close iterator**
File: tests in `language/statements/for-of/` (multiple)
Error: `completion closes iter`
Root cause: `break` inside for-of should call `iterator.return()`.

**5. Generator must not be resumed after return**
File: `test/built-ins/AsyncGeneratorPrototype/return/return-suspendedStart-broken-promise.js`
Error: `Generator must not be resumed.`
Root cause: After `.return()` is called on a suspended async generator, calling `.next()` should not resume the generator body.

### Breakdown by location

| Area | Count |
|------|-------|
| async-generator yield* | ~80 |
| for-of/for-await-of break/return | ~40 |
| destructuring iterator close | ~20 |
| async generator return protocol | ~7 |

## Root cause in compiler

In `src/codegen/statements.ts`:

1. **for-of/for-await-of**: When a `break`, `return`, or `throw` occurs inside the loop body, the compiler must emit code to call `iterator.return()` before exiting the loop. Currently, `break` just jumps out of the loop without closing the iterator.

2. **yield***: The yield* delegation protocol requires closing the inner iterator when an abrupt completion occurs. The compiler does not emit the close sequence.

3. **Destructuring**: When destructuring does not exhaust the iterator (e.g., `let [a] = [1, 2, 3]`), the iterator should be closed after binding. When destructuring throws, the iterator should also be closed.

In `src/codegen/expressions.ts`:

4. **Generator return**: When `.return()` is called on a generator, it should mark the generator as completed. Subsequent `.next()` calls should return `{value: undefined, done: true}` without re-entering the generator body.

## Suggested fix

1. In for-of/for-await-of compilation:
   - Wrap the loop body in a try-finally
   - In the finally block, check if the loop exited abnormally and call `iterator.return()` if the iterator is not done

2. In yield* compilation:
   - When the inner iterator access fails, close the outer iterator
   - Implement the full yield* close protocol per ES spec 14.4.14

3. In destructuring:
   - After binding is complete, if the iterator is not done, call `iterator.return()`
   - In the catch path, also call `iterator.return()`

## Acceptance criteria

- for-of break/return calls iterator.return()
- yield* closes iterators on abrupt completion
- Destructuring closes iterators when not exhausted
- >=100 of 147 tests fixed

## Previous Work (Sprint 31)
- **Branch**: `issue-851-iterator-close` (commit 565bf49d)
- **Status**: Code was merged in sprint-31 but sprint was rolled back due to other regressions.
- **Reuse**: Cherry-pick 565bf49d onto a fresh branch from current main, run full test262 to verify no regression.

## Suspended Work
- **Worktree**: /workspace/.claude/worktrees/issue-851-iterator-close
- **Branch**: issue-851-iterator-close (commit 30f1bf1f)
- **Done**: Cherry-picked 565bf49d (emitClosureCallExport, symbol ID resolution, iterator close runtime). Smoke-tested basic for-of break on arrays (PASS). Diagnosed root cause of custom iterable failure.
- **Remaining**: Fix `emitClosureCallExport()` in `src/codegen/index.ts:1623` — it skips base wrapper types (line 1640), so `__call_fn_0` is never emitted when closures have no captures. Fix: dispatch by **funcref type** instead of struct type (funcref types with different return types remain distinct even after V8 isorecursive struct canonicalization). Then verify iterator-close-via-break.js and other test262 samples pass.
- **Resume**:
  1. Read `src/codegen/index.ts` lines 1623-1735 (`emitClosureCallExport`)
  2. Replace struct-type dispatch with funcref-type dispatch: use one representative struct type for `ref.cast` + `struct.get 0` to extract funcref, then `ref.test` each funcref func type to dispatch
  3. Remove the base-wrapper skip on line 1640
  4. Add a `__funcref` local (kind: funcref) to the function locals
  5. Test with `/tmp/smoke-851e.ts` pattern — verify `__call_fn_0` appears in exports
  6. Run sample test262 iterator-close tests to confirm fix

## 2026-04-06 Re-analysis

Latest fully inspectable full JSONL (`20260403-024807`) still has **126**
failures with `abrupt completion closes iter`:

| Category | Count |
|----------|-------|
| language/expressions | 84 |
| language/statements | 42 |

Current samples are concentrated in async-generator `yield*` close paths:

- `test/language/expressions/async-generator/named-yield-star-getiter-async-returns-abrupt.js`
- `test/language/expressions/async-generator/named-yield-star-getiter-sync-returns-null-throw.js`
- `test/language/expressions/async-generator/named-yield-star-next-not-callable-undefined-throw.js`

This indicates the unresolved remainder is not primarily simple `for-of break`
anymore. The dominant residual root cause is still `yield*` / delegated iterator
close behavior, which matches the suspended `emitClosureCallExport` follow-up
notes above.
