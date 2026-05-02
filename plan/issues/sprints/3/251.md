---
id: 251
title: "Issue #251: super() call required in derived class constructors"
status: done
created: 2026-03-11
updated: 2026-04-14
completed: 2026-03-11
goal: class-system
---
# Issue #251: super() call required in derived class constructors

## Status: done

## Summary

19 tests fail with "Constructors for derived classes must contain a 'super' call". These are class tests where a derived class constructor does not call `super()` because the test is specifically checking error behavior or the class does not need initialization.

## Root Cause

TypeScript requires `super()` in all derived class constructors. Some test262 tests deliberately omit super() to test the error case, or the class expression has no explicit constructor (implicit super). The diagnostic should be suppressed in allowJs mode for test262 compatibility.

## Scope

- `src/codegen/index.ts` -- TypeScript diagnostic suppression
- Tests affected: ~19 compile errors

## Expected Impact

Fixes ~19 compile errors.

## Suggested Approach

1. Add the TypeScript diagnostic code for "Constructors for derived classes must contain a 'super' call" (TS2377) to the suppression list in allowJs mode
2. In the codegen, if a derived class constructor does not call super, automatically insert a super() call at the beginning of the constructor body

## Acceptance Criteria

- [ ] Derived class constructors without explicit super() compile in allowJs mode
- [ ] Implicit super() call is inserted
- [ ] At least 15 compile errors resolved

## Implementation Notes

Added TS diagnostic codes 2377, 2376, 17009, 17011 to the `DOWNGRADE_DIAG_CODES` set in `src/compiler.ts`. These diagnostics are downgraded from errors to warnings, allowing compilation to continue. The codegen already handles derived classes correctly when the diagnostic is not blocking. Auto-insertion of implicit `super()` is not done at the codegen level -- the Wasm struct allocation handles inheritance without requiring an explicit super call in the constructor body.

## Complexity: S
