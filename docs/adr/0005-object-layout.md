# ADR-005 — Object layout via WasmGC struct types (closed-world)

**Status**: Accepted
**Date**: 2026-04-27

This ADR is a sub-decision of ADR-001 — it concerns the static specialization
path for JS objects.

## Context

JavaScript objects are open: any property key may be added, deleted, or
replaced at runtime, including with values of unrelated types. A naïve
representation handles this by storing every object as a hash map of string
keys to boxed values. Property access is then a hash lookup at every site,
even when the program never adds or removes properties from a given object.

In practice, the great majority of JS objects encountered in real code have
a stable set of property names that is determined by their constructor or
literal site. Class instances, factory functions returning literals, and
records produced by JSON parsers all fall in this category. The closed-world
analysis from ADR-001 can determine this set statically within a compilation
unit, by examining all read and write sites that reach the allocation.

## Decision

Compile JS objects to typed WasmGC structs when the closed-world analysis
proves the property set is statically known. Each distinct shape becomes a
declared struct type in the Wasm type section. Property reads lower to
`struct.get`; property writes lower to `struct.set`.

When the analysis cannot prove a stable shape (dynamic indexing,
unrestricted assignment, reflective access), the object falls back to a
map-backed representation reachable through `externref`, with all property
operations going through the slow path.

## Consequences

Positive: property access on stably shaped objects is a single typed Wasm
instruction rather than a hash lookup. Class instantiation is allocation of
a typed struct, not a map. Field types are unboxed where the analysis proved
the type (`f64` for numeric fields, `i32` for booleans, struct refs for
nested objects). Memory layout is decided once, at compile time, and is
visible in the type section.

Negative: shapes that the analysis cannot prove fall back to the slow path,
with no graceful in-between. Adding a previously-unanalyzed dynamic write
site can cause an entire shape to deoptimize to the boxed representation.
Hot polymorphic dispatch across many shapes is not specialized further than
the analysis can prove statically.

## Alternatives rejected

- **Hidden-class / inline-cache approach**: rejected. Inline caches require
  speculative optimization at runtime, which is exactly what AOT compilation
  in ADR-004 declines to do.
- **Always boxed**: rejected. Pays the hash-lookup cost on every object,
  including the majority that have stable shapes.
