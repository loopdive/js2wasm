---
id: 1314
sprint: 50
title: "Wasm codegen: __closure_N stack underflow — call emits wrong argument count"
status: ready
created: 2026-05-07
updated: 2026-05-07
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: closures, call
goal: spec-completeness
---
# #1314 — `__closure_N` call stack underflow (87 compile errors)

## Problem

87 tests produce compile errors of the form:

```
L72:3 invalid Wasm binary (WebAssembly.instantiate(): Compiling function #22:"__closure_0" failed:
  not enough arguments on the stack for call (need 2, got 1) @+2406)
```

The pattern is consistent: a `call` instruction inside a closure function (`__closure_0`, `__closure_1`, etc.) emits the wrong number of arguments on the stack. The binary fails Wasm validation at instantiate time.

## Sample failures

```
test/language/statements/for-of/async-func-dstr-var-async-ary-ptrn-rest-id-elision.js
test/language/statements/for-of/async-gen-dstr-const-async-ary-ptrn-elem-ary-rest-init.js
test/built-ins/Array/prototype/forEach/15.4.4.18-2-5.js
```

Pattern: frequently async functions, destructuring rest patterns, closures inside for-of or async generator bodies.

## Suspected location

Closure lift codegen (`src/codegen/closures.ts`) — when lifting a closure that calls a function with captured arguments, the arity emitted for the `call` or `call_ref` may be off by one (e.g. missing `this`/receiver, or forgetting to push the closure struct itself as the first argument for a method call).

Also check: `emitClosureBody` or equivalent path that emits the `call` instruction for captured function calls inside lifted closures.

## Acceptance criteria

- 0 compile errors matching `not enough arguments on the stack for call` in test run.
- The 87 currently-failing tests reclassify (ideally to pass, or at least to a runtime failure with a descriptive error).
- No regressions in `tests/equivalence.test.ts`.
