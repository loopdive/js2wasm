# ADR-003 — WasmGC over linear memory

**Status**: Accepted
**Date**: 2026-04-27

## Context

A JavaScript-to-Wasm compiler must place JS heap objects somewhere. There
are two viable representations in Wasm today: linear memory (with a
hand-written garbage collector), and WasmGC reference types (the host runtime
manages the heap, and structs and arrays are first-class typed values).

Linear memory requires the compiler to ship its own collector — mark/sweep
or compacting — and to implement allocation, free lists, layout, and root
scanning. None of that work is incremental; the collector either is correct
or it is not. The collector also runs on every host that loads the module,
duplicating work the host's GC is already doing for `externref` and host
values.

WasmGC, by contrast, gives the host runtime responsibility for the JS heap.
Struct and array types are declared in the module's type section, allocated
with `struct.new` / `array.new`, and collected by the host. WasmGC struct
types map naturally to JS object shapes (fields with declared types, optional
mutability), which is exactly what the closed-world specialization in ADR-001
is producing. Cycles between WasmGC values and host `externref` values are
collected uniformly.

## Decision

Use the WasmGC type system as the compilation target for JS values. JS
objects, classes, closures, and arrays are lowered to WasmGC struct and array
types. The compiler does not implement a garbage collector.

## Consequences

Positive: no GC implementation cost; correctness of collection is delegated
to the host; struct types are a natural fit for the static path of ADR-001
and for Component Model record types; cycles between compiled values and
host `externref` are uniformly handled.

Negative: requires a WasmGC-capable host (wasmtime 44+, Chrome 119+,
Firefox 120+). Hosts without WasmGC cannot run the output. Some structural
operations that are trivial in linear memory (raw memory copies, in-place
type punning) are not expressible directly and require explicit conversion.

## Alternatives rejected

- **Linear memory + custom GC**: rejected. The implementation cost is
  large, the resulting collector duplicates host work, and the linear-memory
  representation does not align with the Component Model. The performance
  upside is real for tightly packed numeric workloads but does not pay back
  the implementation and maintenance cost.
- **Linear memory + reference counting**: rejected. Cycles require a
  fallback collector anyway, and reference counts are a per-write cost that
  WasmGC avoids.
