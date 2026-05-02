---
id: 738
title: "- instanceof correctness (276 tests)"
status: done
created: 2026-03-22
updated: 2026-04-14
completed: 2026-03-25
priority: medium
feasibility: medium
goal: error-model
depends_on: [678]
test262_fail: 276
files:
  src/codegen/expressions.ts:
    modify:
      - "instanceof — delegate to host for unresolvable constructors"
  src/runtime.ts:
    modify:
      - "instanceof host import"
  tests/equivalence/helpers.ts:
    modify:
      - "instanceof test helper"
---
# #738 -- instanceof correctness (276 tests)

## Status: done

## Problem

276 tests fail on `instanceof` checks. The operator likely does a simple type tag comparison instead of walking the prototype chain as the spec requires.

### ES spec behavior
- `x instanceof C` checks if `C.prototype` is in the prototype chain of `x`
- Must support `Symbol.hasInstance` override
- Must handle cross-realm objects
- Must throw TypeError if right-hand side is not callable

### What needs to happen

1. Implement prototype chain walk for instanceof (depends on #678)
2. Check `Symbol.hasInstance` if present on the constructor
3. Throw TypeError for non-callable right-hand side

## Complexity: M (<400 lines)

## Implementation Summary

**Commit**: 99709f88 — `fix: delegate instanceof to host for unresolvable constructors (#738)`

**What was done**: Delegated instanceof checks to the JS host runtime for constructors that can't be resolved at compile time, enabling correct prototype chain walks. Added host import and test helpers.

**Files changed**: `src/codegen/expressions.ts` (+256), `src/runtime.ts` (+7), `tests/equivalence/helpers.ts` (+7)
