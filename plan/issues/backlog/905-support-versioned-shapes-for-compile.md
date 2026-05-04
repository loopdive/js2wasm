---
id: 905
title: "Support versioned shapes for compile-time-known prototype mutation"
status: ready
created: 2026-04-02
updated: 2026-04-28
priority: medium
feasibility: hard
reasoning_effort: max
goal: compiler-architecture
depends_on: [743, 746]
files:
  src/shape-inference.ts:
    modify:
      - "Track prototype/layout versions, not only single fixed shapes"
  src/codegen/expressions.ts:
    modify:
      - "Lower known prototype transitions to versioned struct/layout dispatch"
  src/codegen/index.ts:
    modify:
      - "Emit shape/prototype version metadata and select specialized access paths"
---
# #905 -- Support versioned shapes for compile-time-known prototype mutation

## Problem

Prototype mutation is usually treated as a reason to fall back to generic JS object behavior.

But in a closed-world compilation model, many prototype changes are known at compile time. In those cases, the compiler should not have to abandon specialization entirely.

## Goal

Support versioned shapes/layouts for prototype changes that are visible in the whole program.

## Approach

1. infer an initial object shape/layout
2. detect compile-time-known prototype/layout transitions
3. assign a new versioned shape for each transition
4. compile property reads/writes/method dispatch against the active version
5. fall back only when the mutation is truly dynamic or reflective beyond what the compiler can model

## Examples

Known-at-compile-time cases:

- constructor or setup code that swaps a prototype in a fixed way
- staged object initialization that extends a shape in known steps
- class/prototype patterns whose final shape graph is visible to the compiler

Truly dynamic cases should still use the generic path.

## Acceptance criteria

- compile-time-known prototype/layout mutations no longer force unconditional generic property handling
- versioned shape transitions are explicit in analysis/codegen
- direct specialized access remains possible before and after known transitions
- dynamic/reflective prototype mutation still falls back conservatively
