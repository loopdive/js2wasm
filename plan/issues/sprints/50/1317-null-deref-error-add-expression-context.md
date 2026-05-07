---
id: 1317
sprint: 50
title: "null dereference error: add expression / variable context (573 opaque runtime failures)"
status: ready
created: 2026-05-07
updated: 2026-05-07
priority: medium
feasibility: easy
reasoning_effort: medium
task_type: improvement
area: runtime, error-messages
goal: spec-completeness
---
# #1317 — `dereferencing a null pointer` needs expression context (573 failures)

## Problem

573 test failures report only:

```
L41:3 dereferencing a null pointer [in test()]
L65:3 dereferencing a null pointer [in __closure_0()]
```

The line number and function name are present, but there is no information about which expression produced the null, what variable was expected to be non-null, or what operation was attempted.

## Examples

```
L41:3 dereferencing a null pointer [in test()]
L55:3 dereferencing a null pointer [in fn() at L55: async function fn() {]
```

These are `ref.as_non_null` traps — the Wasm instruction asserts a reference is non-null, traps if it is.

## Fix approach

**Short-term (error message improvement):** In the test262 worker execution error handler, when a `WebAssembly.RuntimeError` with message `"null dereference"` or `"dereferencing a null pointer"` is caught:
1. Extract the full `.stack` trace from the RuntimeError.
2. Include the first non-wasm frame (the JS wrapper) in the error output.
3. This immediately contextualizes the failure to a specific WAT function.

**Longer-term (codegen improvement):** Replace `ref.as_non_null` traps with guarded loads that throw a JS-style `TypeError: Cannot read property of null` with the property name. This requires generating a `ref.is_null` check + conditional throw instead of `ref.as_non_null`. ~50% of null_deref failures would become self-diagnosing TypeErrors with property names.

The quick win (stack trace extraction) is the immediate fix here.

## Acceptance criteria

- `dereferencing a null pointer` errors include the full Wasm function call stack (at least 2 frames).
- Ideally includes the WAT snippet around the failing instruction.
- 0 bare null dereference errors without call stack context.
