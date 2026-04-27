# ADR-007 — Closure conversion via WasmGC ref-cell structs

**Status**: Accepted
**Date**: 2026-04-27

## Context

JavaScript closures may capture variables from the enclosing scope, and
those variables may be mutated either by the enclosing function or by the
closure itself after the closure has been created. The classic example is a
`for` loop that creates a closure per iteration referring to the loop
variable: the closures must observe each other's mutations of that variable
through a shared cell, not snapshot it.

Wasm has no implicit cell semantics. Locals live on the stack and are not
addressable; once a function returns, its locals are gone. To preserve JS
mutable-capture semantics, captured mutable variables must be promoted to
the heap so that all closures that capture them share the same storage.

Captures that are provably never mutated after the closure is created do
not need a cell — they can be copied into the closure's environment
directly.

## Decision

Convert each mutably captured variable to a one-field WasmGC struct of the
form `(struct (field $value (mut T)))`, where `T` is the inferred type of
the variable. All reads of the captured variable lower to `struct.get` on
the cell; all writes lower to `struct.set`. Multiple closures that capture
the same variable share a reference to the same cell.

Captures that escape analysis proves to be effectively immutable after the
closure's creation are inlined directly into the closure's environment
struct, with no indirection.

## Consequences

Positive: correct mutable-capture semantics across loop iterations,
recursive closures, and async/generator continuation frames. No separate
heap or allocator is needed — cells are ordinary WasmGC structs and are
collected by the host. The structural type of each closure is visible in
the Wasm type section, making escape analysis and shape sharing
straightforward.

Negative: heap allocation rate is higher than for code that uses pure
local variables — every mutable capture is an allocation. Field types are
fixed at the cell's struct type, so a variable whose inferred type widens
across the analysis must use a wider cell type (in the worst case,
`externref`).

## Alternatives rejected

- **Stack-allocated environments**: rejected. Wasm locals are not
  addressable and do not survive function return, so this cannot represent
  closures that outlive their defining frame.
- **Single big environment object per function**: rejected. Forces all
  captures to share a lifetime, retains immutable values longer than
  necessary, and obscures escape information.
