# ADR-006 — Boundary guards at host-import surfaces

**Status**: Accepted
**Date**: 2026-04-27

This ADR is a sub-decision of ADR-001 — it concerns the boundary thunk
strategy where compiled code meets the dynamic world.

## Context

A js2wasm-compiled module exists alongside a host environment (Node.js,
WASI, browser, or another Wasm component). At every call out to that host —
DOM APIs, filesystem APIs, callbacks invoked by the host, dynamic data
fetched at runtime — the values flowing back across the boundary arrive as
host references (`externref`). Inside the compiled core, however, values
are tracked in their specific WasmGC struct types so that property access
and arithmetic can use unboxed instructions.

The two type domains must be reconciled at the boundary. TypeScript
annotations on the imported function describe the expected shape, but those
annotations are unsound and erased — the compiler cannot trust them as a
runtime invariant (see ADR-009). A runtime check is required at the
boundary itself.

## Decision

Emit a boundary guard at every host-import call site. The guard tests the
returning `externref` against the expected WasmGC type using `ref.test`,
and either narrows the value with `br_on_cast` for the success path or
takes a slow / fallback path. Inside the compiled module, values are then
held in their specific struct types and operated on with typed
instructions. TypeScript annotations on the imported function are used to
*choose* which type to test against, not to skip the test.

## Consequences

Positive: heterogeneous host data is handled correctly under JS semantics —
the compiled core can rely on its types being real types. The cost is one
Wasm instruction per boundary crossing, which is negligible compared to the
host-call cost itself. The guards make the dynamic / static boundary
explicit and auditable.

Negative: every boundary requires a corresponding type, even for
single-shot host calls — the compiler must materialize a struct type for
each shape returned by a host import. Mis-shaped host responses surface as
guard-failure paths rather than later, more confusing crashes; this is the
intended behavior, but it does require fallback code at every site.

## Alternatives rejected

- **Trust TypeScript annotations at the boundary**: rejected. TS is unsound
  and erased; trusting annotations would let bad host data corrupt typed
  state inside the compiled core, with crashes far from the cause.
- **Box everything that crosses the boundary**: rejected. Forces the entire
  compiled core back into the dynamic representation and erases the gains
  from ADR-005.
