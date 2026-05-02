---
id: 1104
title: "Wasm-native Error construction and stack traces without JS host"
status: ready
created: 2026-04-12
updated: 2026-04-12
priority: medium
feasibility: medium
reasoning_effort: high
task_type: feature
language_feature: error-handling
goal: standalone-mode
es_edition: ES5
---
# #1104 — Wasm-native Error construction and stack traces

## Problem

Error, TypeError, RangeError, SyntaxError, URIError, EvalError, ReferenceError, and AggregateError are currently constructed via the JS host's `builtinCtors` table in runtime.ts. This works because JS Error objects carry stack traces that are useful for debugging in a browser/Node environment.

In standalone mode, there is no JS Error constructor. Errors need to be Wasm-native objects.

## Approach

### Error as WasmGC struct

```wasm
(type $Error (struct
  (field $message (ref $String))
  (field $name    (ref $String))
  (field $stack   (ref null $String))  ;; optional, see below
))
```

Each error subclass (TypeError, etc.) is the same struct with a different `$name` field value.

### Stack traces

Options:
1. **No stack traces in standalone mode** — `error.stack` returns `undefined`. Simple, no overhead.
2. **Compile-time stack info** — embed function names and source locations as string constants. When `throw` executes, capture the current call stack via Wasm stack introspection (if the runtime supports it) or a shadow stack.
3. **WASI-specific**: some WASI runtimes expose stack trace APIs — use them where available.

Recommend starting with option 1 (no stack traces) and upgrading to option 2 later.

### try/catch interop

Error objects thrown in Wasm use the exception handling proposal (`throw`, `try`/`catch`/`catch_all`). The thrown value is the Error struct ref. `catch` binds it, `instanceof` checks the struct type.

## Acceptance criteria

- [ ] `new Error("msg")` compiles in standalone mode, produces a struct with `.message === "msg"`
- [ ] `new TypeError("msg")` / `new RangeError("msg")` etc. all compile
- [ ] `error.name` returns the correct error type name
- [ ] `error.message` returns the constructor argument
- [ ] `error instanceof TypeError` works correctly
- [ ] throw/catch with Error subclasses works in standalone mode

## Complexity

M — the struct definition is simple; the work is in wiring up all 7 error subclasses + AggregateError

## Related

- #835 Unknown extern class: Error types (CE in current host mode)
- #1092 Wrong error type (runtime semantics)
