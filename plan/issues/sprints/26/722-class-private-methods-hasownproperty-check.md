---
id: 722
title: "Class private methods: hasOwnProperty check fails (484 FAIL)"
status: done
created: 2026-03-21
updated: 2026-04-14
completed: 2026-03-21
priority: high
goal: property-model
---
# Issue #722: hasOwnProperty returns true for class methods

## Problem

484 test262 tests fail because `Object.prototype.hasOwnProperty.call(instance, "m")` returns true for class methods. Per ES spec:

- Class methods live on the **prototype**, not on instances -- `hasOwnProperty` should return false
- Private members (starting with `#`) are never accessible via string property names

Our `compilePropertyIntrospection` function was including all TypeScript type properties (including methods and private members) in the "own property" set.

## Root Cause

In `compilePropertyIntrospection` (src/codegen/expressions.ts), the `tsProps` set was built from `receiverType.getProperties()` without filtering. This returned ALL properties including:
1. Prototype methods (e.g., `getX`, `pub`) -- should NOT be own properties
2. Private identifiers (e.g., `#m`, `#secret`) -- inaccessible by string name

Additionally, struct field names included `__tag` (internal compiler field) and fields from private declarations (e.g., `#x` stored as struct field `x`).

## Fix

1. **Filter tsProps**: Skip properties whose declarations are all `MethodDeclaration` or `MethodSignature` (prototype methods). Skip properties starting with `#` (private identifiers).

2. **Filter struct field names**: Exclude internal fields starting with `__` (like `__tag`). Exclude fields that correspond to private TS members (by checking if `#fieldName` exists in TS type properties).

## Implementation Summary

### What was done
- Modified `compilePropertyIntrospection` in `src/codegen/expressions.ts` to correctly filter own properties
- Added 2 new equivalence tests to `tests/hasownproperty-call.test.ts`

### Files changed
- `src/codegen/expressions.ts` -- filtered tsProps and structFieldNames in compilePropertyIntrospection
- `tests/hasownproperty-call.test.ts` -- added tests for method and private method exclusion

### What worked
- TS type checker's `getProperties()` returns property symbols with declarations, making it easy to distinguish methods from data properties
- Private identifiers always start with `#` in the TS type system

### Tests now passing
- `hasOwnProperty` returns false for class methods (prototype properties)
- `hasOwnProperty` returns false for private method names (without `#`)
- All existing hasOwnProperty tests continue to pass
