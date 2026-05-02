---
id: 276
title: "Issue #276: Computed property name must be of assignable type"
status: done
created: 2026-03-11
updated: 2026-04-14
completed: 2026-03-12
priority: low
goal: builtin-methods
files:
  src/compiler.ts:
    new: []
    breaking:
      - "DOWNGRADE_DIAG_CODES: add computed-property-name-type diagnostic code to suppression set"
---
# Issue #276: Computed property name must be of assignable type

## Status: done

## Summary
~33 tests fail with "A computed property name must be of type 'string', 'number', 'symbol', or 'any'". This TypeScript diagnostic blocks compilation when computed property keys are expressions that TypeScript cannot narrow to a valid key type. In allowJs mode, these should be accepted.

## Category
Sprint 4 / Group C

## Complexity: XS

## Scope
- Suppress the computed property name type diagnostic in allowJs mode
- Ensure the codegen handles arbitrary expression types as property keys
- Update diagnostic filtering in `src/codegen/index.ts`

## Acceptance criteria
- Computed property names with expression keys compile in allowJs mode
- At least 20 compile errors resolved

## Implementation Summary

Resolved as part of #242. Diagnostic code TS2464 was added to `DOWNGRADE_DIAG_CODES` in `src/compiler.ts`.
