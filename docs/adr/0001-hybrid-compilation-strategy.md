# ADR-001 — Hybrid static–dynamic compilation strategy

**Status**: Accepted
**Date**: 2026-04-27

## Context

Compiling JavaScript to Wasm creates a fundamental tension. JavaScript defines
runtime behavior; TypeScript types are unsound and erased. A purely dynamic
compilation — every value boxed, every property access reflected — is correct
but slow. A purely static compilation — trust the declared types, lower
directly to typed Wasm — is fast but unsound under JavaScript semantics: a
single `any`-typed callsite, a `with` block, a dynamic property assignment, or
a TypeScript unsoundness corner case is enough to invalidate the lowering.

A hybrid strategy is needed that preserves full JS semantics while enabling
aggressive optimization where it is safe to do so.

## Decision

Adopt closed-world specialization guided by whole-program analysis (not
TypeScript annotations), with boundary guards at all dynamic/unknown
boundaries, and dynamic fallback representations where invariants cannot be
proven. Concretely:

1. Within a compilation unit, perform whole-program control-flow, call-graph,
   and value-flow analysis to infer value types and object shapes. Only
   *proven* invariants are used for specialization.
2. Lower stable structures to Wasm GC struct types, unboxed primitives (`f64`,
   `i32`), and typed arrays. If invariants cannot be proven, use a dynamic
   (boxed) representation.
3. At all boundaries between compiled code and dynamic/untyped JS, insert
   boundary thunks that validate and normalize values according to JS
   semantics. TypeScript annotations seed the analysis as constraints, not
   ground truth (see ADR-009).
4. Dynamic features (`eval`, dynamic property access, reflection) force
   fallback to boxed representations or separately compiled units, but they
   do not invalidate specialization in unrelated proven regions.
5. When multiple compilation units are visible, link-time optimization may
   eliminate redundant boundary thunks where both sides are known.

## Consequences

Positive: full JS semantics preserved; high performance in common cases;
specialization is localized so dynamic behavior does not infect static
regions.

Negative: dual representations (boxed and unboxed) increase compiler
complexity; the design requires shape inference, escape analysis, and careful
boundary handling.

Alternatives rejected: fully dynamic (correct but slow); fully static / trust
types (unsound under JS); TypeScript-driven lowering (TS is unsound and
erased); restricted-language subset (breaks JS compatibility — see ADR-002).
