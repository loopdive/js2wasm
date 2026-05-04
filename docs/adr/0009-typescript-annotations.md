# ADR-009 — TypeScript annotations as inference seeds, not ground truth

**Status**: Accepted
**Date**: 2026-04-27

This ADR is a sub-decision of ADR-001 — it concerns how the compiler treats
TypeScript type information.

## Context

TypeScript's type system is unsound: it permits programs whose runtime
behavior violates declared types. `as` casts, `any`, intersection types,
function-parameter bivariance, and external `.d.ts` files that lie about
their JS counterparts are all common sources of TS-passing programs whose
runtime values do not match their declared shapes. TypeScript types are
also erased — there is no runtime enforcement. Relying on TS annotations
as ground truth for lowering decisions would produce incorrect code for any
program that exploits this unsoundness, including programs that do so
unintentionally.

At the same time, ignoring annotations entirely wastes information that
narrows the inference search space substantially. A function declared
`(x: number) => number` is a strong hypothesis — almost always the
inference will eventually conclude the same thing, but it is much cheaper
to start from that hypothesis than to derive it from scratch. Annotations
also document programmer intent, which is a useful seed when the program
is not yet self-consistent (for example, partway through a refactor).

## Decision

TypeScript annotations are treated as initial constraints — hypotheses —
for the whole-program analysis described in ADR-001. They seed the
inference and reduce convergence cost, but every lowering decision
requires *proof* from the analysis, not just a matching annotation. A
`number` annotation on a parameter is a constraint; if the call graph
cannot prove that all callers pass `f64`, the parameter stays `externref`
and the function's body is compiled accordingly.

The TypeScript checker (used as the frontend, see ADR-011) also infers
types for unannotated values from initializers and assignment patterns.
These inferred types are seeded into the analysis on the same footing as
explicit annotations.

## Consequences

Positive: correct output for unsound TS programs — the compiler does not
generate code that assumes a property that the runtime can violate. Higher
inference precision than a fully annotation-free approach, because the
analysis starts from useful seeds. Plain `.js` input (no annotations) is
handled by the same machinery, just with fewer seeds.

Negative: requires a two-pass design — seed from annotations, then
validate via analysis. Programs that *do* match their declared types
incur the full analysis cost anyway; we cannot shortcut by trusting the
annotation. Programmers may be surprised that an annotated `number`
parameter compiles to an `externref`-typed Wasm parameter when the call
graph cannot prove all callers conform.

## Alternatives rejected

- **Trust TS annotations directly**: rejected because TS is unsound; this
  produces incorrect code for legal but unsound programs.
- **Ignore TS annotations**: rejected because it discards a useful
  starting point and forces the analysis to converge from scratch even
  when the programmer has already done the typing work.
