# ADR-011 — Implementation language: TypeScript, with the `typescript` compiler package as the frontend

**Status**: Accepted
**Date**: 2026-04-27

## Context

A compiler needs an implementation language and a frontend (parser + type
resolver). The choices are independent but they interact. For a JavaScript
/ TypeScript → Wasm compiler, the options for implementation language
include Rust, Go, C++, Java, and TypeScript itself. The options for
frontend include a custom parser, Babel, Acorn, SWC (Rust), tree-sitter,
and the `typescript` npm package (Microsoft's official TypeScript
compiler).

The implementation language affects iteration speed, ecosystem fit, and
the semantic gap between the language being implemented and the language
implementing it. The frontend affects how much of the language is parsed
correctly out of the box and whether type information is available to
seed the closed-world analysis (ADR-001 / ADR-009).

## Decision

Implement the compiler in TypeScript, using the `typescript` npm package
as the frontend for both parsing and type resolution.

For the implementation language: TypeScript is the source language being
compiled. Working in the same language reduces the semantic gap — the
compiler author reasons about JS/TS semantics in the same language they
are implementing, making it easier to validate that output Wasm preserves
the correct behavior. Build-tool performance requirements are low (an
AOT compiler runs once at build time, not in a hot loop); Rust or C++
would add implementation complexity without a runtime benefit. The
TypeScript ecosystem provides vitest for testing, ts-node / tsx for
development, and a large library of utilities.

For the frontend: the `typescript` package provides a battle-tested
parser that handles the full TypeScript and JavaScript grammar
(TypeScript is a strict superset of JavaScript, so the same parser
handles both). More importantly, it provides a type checker whose output
is used in two ways:

1. **For TypeScript files**, explicit type annotations (`: number`,
   `: string`, class shapes, return types) are extracted as initial
   constraints for the closed-world analysis. These seed the inference
   without being trusted as ground truth (see ADR-009).
2. **For plain JavaScript files and missing annotations**, the
   TypeScript checker performs its own inference on unannotated code —
   it can infer the type of a variable from its initializer, a
   function's return type from its body, and object shapes from
   assignment patterns. These inferred types are available through the
   same compiler API and seed the analysis even when the source has no
   explicit annotations. This makes the frontend useful for pure JS
   input, not only TypeScript.

## Consequences

Positive: full TypeScript and JavaScript grammar handled correctly
without a custom parser. Type information is available for both
annotated TypeScript and unannotated JavaScript, seeding the closed-world
analysis in both cases. Implementation language matches the source
language — semantic reasoning is direct. Fast iteration via the
TypeScript toolchain.

Negative: the `typescript` package is large (~30MB) and its compilation
API (using the full language service) is slower than a purpose-built
parser. For a build tool this is acceptable. The compiler is coupled to
TypeScript's AST shape; breaking changes in the TypeScript AST would
require updates. The type checker's inference for plain JS is
conservative — it does not infer types the compiler analysis would
eventually prove, so seeds from `.js` files are fewer than from
fully-annotated TypeScript.

## Alternatives rejected

- **Babel / Acorn**: parse JavaScript but provide no type information —
  the analysis would have to start cold with no seeds.
- **SWC**: provides types but through a Rust FFI boundary, adding
  cross-language complexity that the project does not need.
- **Custom parser**: enormous scope with no benefit over a battle-tested
  implementation.
- **Tree-sitter**: provides a parser but no type checker.
