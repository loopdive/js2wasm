---
id: 724
title: "Object.defineProperty: throw TypeError for invalid operations (150 FAIL)"
status: done
created: 2026-03-21
updated: 2026-04-14
completed: 2026-03-21
priority: medium
feasibility: medium
goal: error-model
test262_fail: 150
files:
  src/codegen/expressions.ts:
    new:
      - "throw TypeError for Object.defineProperty on non-configurable/non-writable"
  src/codegen/index.ts:
    new:
      - "definedPropertyFlags and nonExtensibleVars tracking on CodegenContext"
  tests/equivalence/define-property-typeerror.test.ts:
    new:
      - "6 equivalence tests for defineProperty TypeError behavior"
---
# #724 — Object.defineProperty: throw TypeError for invalid operations (150 FAIL)

## Status: done

## Problem

150 tests expect `assert.throws(TypeError, function() { Object.defineProperty(...) })` — the spec requires TypeError when redefining non-configurable properties, setting writable on non-configurable, etc. Our implementation silently succeeds or ignores the restriction.

## Approach

Dual-strategy implementation:
1. **Compile-time tracking** (for struct-based objects): Track property descriptor flags in `ctx.definedPropertyFlags` map keyed by `"varName:propName"`. When the same property is redefined, check flags at compile time and emit unconditional `throw` for violations.
2. **Runtime checking** (for externref objects): Emit `emitDefinePropertyFlagCheck()` which stores flags as `__pf_<propName>` properties via `__extern_get`/`__extern_set` and validates at runtime.

Additionally:
- `Object.preventExtensions`/`freeze`/`seal` mark variables in `ctx.nonExtensibleVars` for compile-time tracking, and set `__ne` flag on externref objects for runtime checking.
- Runtime value comparison for struct fields: when redefining a non-writable non-configurable property with a new value, emit `struct.get` + compare + conditional throw.
- Fixed pre-existing bug in `emitThrowString` which used `globalIdx` instead of `index` for `global.get` instructions.

## Implementation Summary

### What was done
- Added property descriptor flag constants and `computeDescriptorFlags()` helper
- Added `emitDefinePropertyFlagCheck()` for runtime flag validation using `__extern_get`/`__extern_set` with `__pf_` prefix keys
- Added compile-time flag tracking via `definedPropertyFlags` and `nonExtensibleVars` on CodegenContext
- Updated `Object.preventExtensions`/`freeze`/`seal` to mark non-extensibility (compile-time for structs, runtime for externrefs)
- Added runtime value comparison for non-writable non-configurable struct fields using `f64.ne`/`i32.ne`
- Fixed `emitThrowString` to use `index` instead of `globalIdx` for proper binary emission
- Used structured IR (nested `body`/`then` arrays) instead of flat block/end markers for compatibility with dead-elimination pass
- Used `ensureLateImport` for `__box_number`/`__unbox_number` to ensure availability

### What worked
- Compile-time tracking handles the most common test262 patterns (same variable, same scope)
- Runtime flag checking via `__pf_` properties works for externref objects
- `extern.convert_any` is NOT usable for storing metadata on structs (opaque to JS)

### What didn't work / limitations
- Can't use `__extern_set` on Wasm GC structs converted to externref (opaque)
- Can't compare values at compile time for the SameValue check, so f64.ne is used (doesn't handle NaN === NaN edge case)
- Runtime flag checking only works for externref objects, not struct-based ones

### Files changed
- `src/codegen/expressions.ts` — defineProperty flag checking, emitThrowString fix
- `src/codegen/index.ts` — added `definedPropertyFlags`, `nonExtensibleVars` to CodegenContext
- `tests/equivalence/define-property-typeerror.test.ts` — 6 new tests

### Tests now passing
- 6 new equivalence tests for defineProperty TypeError behavior
- No regressions in existing define-property or object-mutability tests

## Complexity: M
