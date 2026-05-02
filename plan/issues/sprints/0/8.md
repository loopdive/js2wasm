---
id: 8
title: "Issue 8: Generics"
status: done
created: 2026-02-27
updated: 2026-04-14
completed: 2026-02-28
goal: builtin-methods
---
# Issue 8: Generics

## Status: done

## Summary
Support generic function signatures `<T>` with monomorphization or erasure.

## Motivation
Generics are pervasive in TypeScript — `Array<T>`, `Map<K,V>`, utility functions. Without generics, many real-world functions can't be typed correctly.

## Design options

### Option A: Type erasure (simpler)
At call sites, instantiate the generic with the concrete type argument resolved by tsc. Use `externref` for unconstrained `T`. This works well for identity functions and simple containers.

### Option B: Monomorphization (correct, complex)
For each call site with distinct type arguments, emit a separate specialized Wasm function. Requires call-site tracking and function deduplication. Similar to Rust/C++ templates.

**Recommended starting point: Option A (erasure)**
- Constrained generics (`T extends number`) compile the constraint type.
- Unconstrained `T` uses `externref`.
- The tsc checker already resolves concrete types at call sites — use `checker.getTypeAtLocation(arg)` to get the instantiated type.

## Scope
- `src/codegen/expressions.ts`: when compiling a call to a generic function, use `checker.getContextualType` or `checker.getTypeAtLocation` on each argument to resolve `T`.
- `src/codegen/index.ts`: when collecting generic function declarations, use `any` / `externref` for type params unless constrained.
- Tests: `tests/generics.test.ts`.

## Acceptance criteria
- `function identity<T>(x: T): T { return x; } return identity(42);` returns `42`.
- `function first<T>(arr: T[]): T { return arr[0]; }` works with `number[]`.
