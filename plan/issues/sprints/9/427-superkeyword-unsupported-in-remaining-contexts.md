---
id: 427
title: "SuperKeyword unsupported in remaining contexts (11 CE)"
status: done
created: 2026-03-17
updated: 2026-04-14
completed: 2026-04-14
priority: low
goal: compilable
files:
  src/codegen/expressions.ts:
    new: []
    breaking:
      - "compileSuperExpression — additional super usage patterns"
---
# #427 — SuperKeyword unsupported in remaining contexts (11 CE)

## Problem

11 tests fail with "unsupported expression: SuperKeyword" errors. Issue #375 (done) implemented basic super support, but some patterns remain unhandled.

Remaining patterns likely include:
- `super.method()` calls in non-constructor methods
- `super[computed]` access
- `super` in static methods
- `super` in nested arrow functions within methods

## Priority: low (11 tests)

## Complexity: S

## Acceptance criteria
- [ ] super.method() works in all method contexts
- [ ] super property access patterns supported
- [ ] Reduce SuperKeyword CEs to zero
