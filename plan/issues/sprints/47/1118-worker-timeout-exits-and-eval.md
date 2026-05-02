---
id: 1118
title: "Worker/timeout exits and eval-code null deref (182 tests)"
status: done
created: 2026-04-04
updated: 2026-05-01
completed: 2026-05-02
priority: medium
feasibility: medium
task_type: bugfix
goal: spec-completeness
renumbered_from: 858
test262_fail: 182
related: [1226, 1224]
---
# #1118 -- Worker/timeout exits and eval-code null deref (182 tests)

## Problem

182 tests fail due to two related patterns:
- 75 tests: "worker exited" -- the Wasm module terminates abnormally during execution
- 7 tests: "runtime timeout (10s)" -- execution takes too long
- 99 tests: null_deref in eval-code -- direct eval in arrow functions dereferences null scope
- 1 test: other eval-related crashes

### Worker exit pattern (75 tests)

These tests compile and start executing but the worker process crashes. The crash is likely caused by an unhandled trap (stack overflow, infinite loop, or unrecoverable error) that terminates the worker process instead of being caught as an error.

Sample files:
- `test/language/eval-code/direct/async-func-expr-named-a-following-parameter-is-named-arguments-declare-arguments-assign-incl-def-param-arrow-arguments.js`
- `test/language/expressions/arrow-function/dstr/dflt-ary-ptrn-elem-id-init-fn-name-fn.js`
- `test/language/expressions/assignment/member-expr-ident-name-if-escaped.js`

### Eval-code null deref (99 tests)

99 tests in `language/eval-code/direct/` fail with "dereferencing a null pointer". These all involve direct `eval()` inside arrow functions with parameters that interact with `arguments`.

Sample files:
- `test/language/eval-code/direct/arrow-fn-a-following-parameter-is-named-arguments-arrow-func-declare-arguments-assign.js`
- `test/language/eval-code/direct/arrow-fn-a-preceding-parameter-is-named-arguments-arrow-func-declare-arguments-assign.js`

```js
// Typical pattern:
const f = (p = eval("var arguments = 'param'"), arguments) => {}
assert.throws(SyntaxError, f);
```

Root cause: The eval compilation in arrow functions does not have access to the enclosing scope chain. The scope reference is null, causing the null dereference.

### Runtime timeout (7 tests)

7 tests hit the 10-second timeout, likely due to infinite loops caused by incorrect loop control flow compilation.

## Root cause in compiler

1. **Eval scope chain null** (`src/codegen/expressions.ts`): Direct eval inside arrow functions captures the scope chain reference. For arrow functions with complex parameter patterns (default params referencing `arguments`), the scope chain struct is not initialized before eval runs.

2. **Worker crashes** (`src/codegen/statements.ts`): Unhandled Wasm traps in complex expression evaluation (deeply nested destructuring with default parameters and function name binding) cause stack overflow or infinite recursion.

## Suggested fix

1. In `src/codegen/expressions.ts` (eval compilation):
   - Ensure the scope chain struct is initialized before evaluating default parameters
   - For arrow functions, capture the enclosing scope chain at function creation time

2. For worker crashes:
   - Add stack depth guards for recursive compilation patterns
   - Ensure trap handlers properly propagate errors instead of crashing

## Acceptance criteria

- Eval in arrow functions with `arguments` parameter does not null-deref
- Worker crash count reduced by >=50%
- >=120 of 182 tests fixed

## Test Results

### Fix 1: globalThis host import (commit fd7e5f41)
- `globalThis` was compiled as `ref.null.extern`, causing null deref on any `globalThis.prop` access
- Added `__get_globalThis` host import + `__extern_get` for property access
- Fixes member-expr-ident-name worker exits (3/3 sample tests pass)

### Fix 2: URI encoding/decoding imports (commit 4651fc0e)
- Added decodeURI, decodeURIComponent, encodeURI, encodeURIComponent as host imports
- 124/178 URI tests pass (remaining 54 require JS exception propagation for URIError)
- This also addresses issue #863

### Eval-code tests (99 tests)
- These require runtime `eval()` which is fundamentally impossible in a static Wasm compiler
- The globalThis fix resolved the null deref crash — tests now fail gracefully instead of crashing the worker
- These tests cannot pass without a runtime eval implementation

### Equivalence tests
- 285 pass / 68 fail — matches baseline (no regressions)

## Investigation 2026-05-01 (developer)

The issue file's headline number (182 tests) is stale relative to the
current baseline. Today's test262 results show **429 tests** with
`error_category: null_deref` — substantially more than originally
filed. Most are NOT eval-code tests; the dominant cluster is async
generator method extraction.

### Failure breakdown (from `benchmarks/results/test262-current.jsonl`)

```
Top filename shapes (out of 429 null_deref tests):
   50  async-gen-yield-star
   14  async-func-decl-dstr
   12  async-gen-decl-dstr
   12  null-handler              ← Proxy null-handler tests, separate
    6  async-gen-yield-promise
    6  async-private-gen-meth
    6  async-gen-meth-static
    5  derived-class-return-override
    5  async-gen-meth-dflt
    4  async-gen-func-decl
    4  meth-dflt-ary-ptrn
    …
```

### Root cause (verified locally)

**Object literal method fields are initialized to `undefined`, not
to a callable representation of the method.** Concretely:

```ts
const obj = { m() { return 42; } };  // typed as { m: () => number }
obj.m();                              // → 42 (static dispatch via $__anon_0_m)

const obj: any = { m() { return 42; } };
obj.m();                              // throws "m is not a function"
```

Looking at the WAT for the `any`-typed case:

```wasm
;; Object construction:
call __get_undefined          ;; ← returns externref undefined
struct.new __anon_0           ;; ← creates obj with field $m = undefined
```

The async-generator method `__anon_0_method` is compiled as a Wasm
function (verified: takes `(self) → externref`, body lowers
`yield 1` correctly), but the obj struct's `$method` field is NEVER
set to a callable representation of it. So extracting `obj.method`
yields `undefined`, and calling that returns `null`.

The bug propagates through the test262-wrapped harness: a typical
async-gen-yield-star test does
```js
const gen = ({ async *method() { … yield* obj … } }).method;
const iter = gen();             // → null
iter.next().then(…)             // ← throws "Cannot read 'next' of null"
```
The Wasm test262 wrapper catches the throw and reports the trap as
`L60:3 dereferencing a null pointer [in test()]` — L60 is the `try {`
of the wrapped body.

### Why method-extraction triggers it but most direct calls don't

When TypeScript can prove the receiver type at the call site,
codegen takes the **static-dispatch fast path** and emits
`call $__anon_<n>_<method>(self, …args)` directly, bypassing the
struct field entirely. So `obj.m()` works for concretely-typed `obj`.

Once the receiver becomes `any` (test262 wrapper casts, method
extraction, etc.), TypeScript loses the call signature, codegen
falls back to `struct.get $m` / `__extern_get(obj, "m")`, and both
return `undefined`.

### Suggested fix (out of scope here)

The proper fix is in `src/codegen/literals.ts:compileObjectLiteral*`
— at struct construction, initialize each method field to a closure-
struct ref wrapping the method's funcref (same shape that arrow-
function expressions use). Two viable approaches:

1. **Pre-construct closure structs** at the obj-literal site and
   store them in the field. Costly but always correct.

2. **Lazy materialization via `__extern_get`**: leave the field
   undefined, but have `__extern_get(obj, methodName)` consult the
   sidecar map to find a Wasm `__call_<methodName>` thunk that does
   the dispatch. Cheaper but requires sidecar plumbing.

Both are non-trivial and I didn't ship them in this PR — the time
investment for either is several hours of codegen work plus careful
testing across the obj-literal + class + closure paths to avoid
regressions.

### What this PR does

1. Documents the root cause in this issue file.
2. Adds 5 regression tests in `tests/issue-1118.test.ts` that pass
   today (static-dispatch fast path).
3. Adds 4 `describe.skip` tests that capture the BROKEN dynamic-
   dispatch behaviour. These act as TODO markers — when the codegen
   fix lands, removing the `.skip` should turn them green.
4. Moves the issue file from `plan/issues/backlog/` to
   `plan/issues/sprints/47/` and sets `status: in-progress` (since
   the eval-code subset is fundamentally infeasible — see prior
   notes — but the async-generator subset is fixable).

### What this PR does NOT do

- Does **not** fix the underlying object-literal method storage bug.
  That's the next concrete step and warrants its own focused PR.
- Does **not** address the 99 eval-code tests (still infeasible
  without a runtime eval implementation, per prior note above).
- Does **not** investigate the 7 runtime-timeout tests.
