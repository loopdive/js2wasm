---
id: 1267
title: "optimizer: method calls in expression-statement position silently dropped when return value unused"
status: in-progress
created: 2026-05-02
updated: 2026-05-02
priority: high
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen, optimizer
language_feature: method-calls, side-effects
goal: correctness
related: [1244, 1249]
---
# #1267 — Optimizer drops side-effectful method calls in statement position

## Problem

When a method call appears in **expression-statement position** (i.e. the return value is
discarded), the compiler/optimizer silently drops all but the last call. This causes visible
mutation side-effects (like `this.#count++` inside a method) to be silently lost.

Minimal repro (found during #1249 investigation):

```ts
class Counter {
  #count = 0;
  inc(): void { this.#count++; }
  get(): number { return this.#count; }
}
const c = new Counter();
c.inc();   // call 1
c.inc();   // call 2
c.inc();   // call 3
export const result = c.get(); // expected: 3, actual: 1
```

The WAT confirms only **one** `call` instruction is emitted in the compiled function body
for the three statement-position calls. The third call's return value appears as the FIRST
call's result.

## Scope

- Reproduces with both public and private methods (not specific to `#name` syntax)
- Affects any method call whose return value is `void` or is discarded
- Directly impacts #1244 (Hono): `TrieRouter.add()` and similar mutation methods depend on
  side effects being preserved

## Suspected location

The drop likely happens in the peephole pass (`src/codegen/peephole.ts`) or in the
expression-statement codegen path in `src/codegen/statements.ts` where a `void`-typed
expression's instructions may be elided.

Check: does `compileExpressionStatement` properly emit a `drop` instruction when the
expression produces a value, and does the peephole pass preserve calls whose result is
dropped?

## Acceptance criteria

1. The minimal repro above returns `3` (all three `inc()` calls execute)
2. `tests/issue-1267.test.ts` covers void-return and side-effectful method calls in
   statement position
3. No regression in `tests/equivalence/` or `tests/stress/hono-tier1.test.ts`
