---
id: 1270
sprint: 49
title: "struct field inference Phase 3b: eliminate null-checks on (ref null $T) locals via peephole"
status: done
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

## Resolution (2026-05-03)

The codegen has already been refactored to NOT emit `ref.as_non_null`
on `(ref null $T)` struct receivers. The relevant commits:

- `526f5863f` — "guard ref.as_non_null with null-check-throw to prevent ~854 null pointer traps"
- `ce79a8668` — "convert ref.as_non_null traps to TypeError throws in expressions.ts"
- `619ee0c21` — "coerce receiver type after ref.as_non_null in method call null-guard paths"

These replaced the bare `ref.as_non_null` (which traps with an
uncatchable Wasm error on null) with an explicit `if ref.is_null
(local.tee) then throw $exn else struct.get` pattern — preserving
correct JS TypeError semantics on null/undefined receiver access.

### Verification

- `tests/issue-1270.test.ts` (new) — 6 / 6 passing. Locks in
  `ref.as_non_null` count = 0 across canonical patterns:
  - `distance(createPoint(3, 4))` (issue example)
  - class instance method receiver
  - nested struct property reads
  - class param + multiple field accesses
  - struct field mutation + read
  - the null-deref semantic-preservation case (verifies
    `ref.is_null + throw` is used, NOT `ref.as_non_null`)

The acceptance criterion "zero `ref.as_non_null` instructions" is
already met. The test serves as a regression sentinel — a future
codegen change that re-introduces `ref.as_non_null` gets caught at
PR time.

### Note on the broader peephole optimization

The issue's `## Fix` section originally proposed a peephole pass
that tracks non-null proof (struct.new, non-null-returning calls)
and removes redundant `ref.as_non_null`. That implementation path
is moot now that `ref.as_non_null` itself isn't emitted.

The remaining "redundancy" is repeated `ref.is_null` checks on the
same local across multiple field accesses (e.g. `p.x * p.x +
p.y * p.y` checks p four times). Per the related #1200 LICM
analysis (`plan/notes/wasm-opt-coverage.md`), V8's JIT dedups these
checks at runtime so static elimination would yield no measurable
benefit on V8. If a non-V8 runtime later shows a gap, file a
follow-up.
