---
id: 421
title: "Array.reduce requires callback and initial value (23 CE)"
status: done
created: 2026-03-17
updated: 2026-04-14
completed: 2026-04-14
priority: medium
goal: builtin-methods
files:
  src/codegen/expressions.ts:
    new: []
    breaking:
      - "array method compilation — reduce/reduceRight support"
---
# #421 — Array.reduce requires callback and initial value (23 CE)

## Problem

23 tests fail with "reduce requires callback and initial value" errors. The compiler does not fully support Array.prototype.reduce and Array.prototype.reduceRight.

Issues include:
- reduce without initial value (should use first element as accumulator)
- Callback type inference for reduce accumulator
- reduceRight not implemented

## Priority: medium (23 tests)

## Complexity: S

## Acceptance criteria
- [ ] Array.reduce works with and without initial value
- [ ] Array.reduceRight supported
- [ ] Reduce this CE pattern to zero
