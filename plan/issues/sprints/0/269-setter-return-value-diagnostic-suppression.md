---
id: 269
title: "Issue #269: Setter return value diagnostic suppression"
status: done
created: 2026-03-11
updated: 2026-04-14
completed: 2026-03-12
priority: low
goal: class-system
files:
  src/compiler.ts:
    new: []
    breaking:
      - "DOWNGRADE_DIAG_CODES: add setter-return-value diagnostic code to suppression set"
---
# Issue #269: Setter return value diagnostic suppression

## Status: done

## Summary
~42 tests fail with "Setters cannot return a value" combined with ClassDeclaration/new expression errors. While #240 fixed setter return in some cases, the TypeScript diagnostic still blocks compilation in tests that have setters returning values inside class declarations in expression positions.

## Category
Sprint 4 / Group C

## Complexity: S

## Scope
- Suppress "Setters cannot return a value" diagnostic in allowJs mode
- Ensure setter bodies can contain return statements (value is discarded)

## Acceptance criteria
- Setter with return statement compiles in allowJs mode
- At least 20 compile errors resolved

## Implementation Summary
- Added TS diagnostic code 2408 to `DOWNGRADE_DIAG_CODES` in `src/compiler.ts`
- Combined with #152 which targets the same diagnostic code
- The diagnostic is downgraded from error to warning, unblocking compilation
- Files changed: `src/compiler.ts`
