---
id: 1270
title: "struct field inference Phase 3b: eliminate null-checks on (ref null $T) locals via peephole"
status: ready
created: 2026-05-02
updated: 2026-05-02
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: feature
area: codegen, optimizer
language_feature: object-literal, property-access
goal: performance
depends_on: [1231, 1269]
---
# #1270 — Struct field inference Phase 3b: peephole null-check elimination

## Context

After Phase 1+2 (#1231) and consumer-side specialization (#1269), the remaining overhead is
a null-check on `(ref null $T)` struct locals. Non-nullable `(ref $T)` locals already skip
the null-check. But when a struct flows through a variable typed as `(ref null $T)`, a
`ref.as_non_null` is still emitted before each struct.get.

## Problem

The peephole pass (`src/codegen/peephole.ts`) already drops redundant `ref.as_non_null`
after `ref.cast`. It does NOT yet drop `ref.as_non_null` after a `struct.new` or after a
function call that is proven to return non-null.

## Fix

Extend the peephole pass to track liveness of non-null proof across:
1. `struct.new` — always produces a non-null ref
2. `call $fn` where `$fn` returns `(ref $T)` (non-null) — result is non-null

When a `ref.as_non_null` immediately follows one of these, remove it.

Alternatively: in the IR, use `(ref $T)` (non-null) as the local type wherever the
propagator can prove non-null, so no `ref.as_non_null` is needed in the first place.

## Acceptance criteria

1. `distance(createPoint(3, 4))` WAT snapshot contains zero `ref.as_non_null` instructions
2. No regression in equivalence or struct tests
3. Covered by `tests/issue-1270.test.ts` WAT snapshot guard
