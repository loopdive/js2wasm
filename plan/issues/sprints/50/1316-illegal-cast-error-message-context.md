---
id: 1316
sprint: 50
title: "illegal cast error: add expected type and actual value context (142 opaque runtime failures)"
status: done
created: 2026-05-07
updated: 2026-05-07
priority: medium
feasibility: easy
reasoning_effort: medium
task_type: improvement
area: runtime, error-messages
goal: spec-completeness
---
# #1316 — `illegal cast` needs type context (142 opaque failures)

## Problem

142 test failures report:

```
L65:3 illegal cast [in __closure_0()]
L54:3 illegal cast [in test()]
```

No information about what type was expected, what value was actually present, or which expression triggered the cast. This makes all 142 failures impossible to diagnose without a debugger.

## Root cause

`ref.cast` in WasmGC traps as `IllegalCast` when the runtime type of the reference doesn't match the expected struct type. The Wasm runtime emits the trap but the js2wasm error handler (`catch` in test262-worker.mjs around the execution path) converts it to the bare string `illegal cast` without extracting context.

## Fix

In `scripts/test262-worker.mjs`, in the execution error handler, detect `WebAssembly.RuntimeError` with message matching `illegal cast` or `ref.cast` and augment the message:

1. Capture the WAT snippet around the failing instruction (already partially available via the `wat:` suffix in some errors).
2. Or emit a Wasm-side helper that pre-validates casts with better messages: before each `ref.cast $T`, check `ref.test $T` and throw a JS Error with the type name if it fails.
3. At minimum: include the function name + offset already available in the RuntimeError stack trace.

**Quick win (< 1 hour):** In the worker's catch block, extract the full `error.stack` from `WebAssembly.RuntimeError` and include the first frame. This immediately makes the 142 failures show their call site.

## Sample failures to verify against

```
test/language/expressions/object/object-spread-proxy-no-excluded-keys.js
test/built-ins/Function/prototype/arguments/arguments-in-named-fn-body.js
test/language/statements/for-of/async-func-dstr-var-async-ary-ptrn-rest-id-elision.js
```

## Acceptance criteria

- `illegal cast` errors include at minimum: the function name + the WAT instruction offset.
- Ideally: expected struct type name (e.g. `$vec_externref`) extracted from the RuntimeError message.
- 0 bare `illegal cast` errors without any supplemental context in the error log.
