---
id: 797
title: "- Property descriptor subsystem (~5,000 tests)"
status: done
created: 2026-03-26
updated: 2026-04-14
completed: 2026-04-14
priority: critical
feasibility: hard
goal: ci-hardening
test262_fail: ~5000
note: "All phases done. 797a flags table, 797b getOwnPropertyDescriptor, 797c defineProperty/defineProperties runtime, 797d freeze/seal."
---
# #797 -- Property descriptor subsystem (~5,000 tests)

## Problem

Thousands of tests depend on property descriptors: `Object.getOwnPropertyDescriptor`, `Object.defineProperty`, `Object.freeze/seal/preventExtensions`, and property attribute checks (writable, enumerable, configurable). Without these, any test using `propertyHelper.js`, `verifyProperty`, or descriptor-based assertions fails.

## Architecture

### Wasm-native property metadata

Each struct field gets a companion **4-bit flags field** stored in a parallel metadata array:

```
bit 0: writable (default 1)
bit 1: enumerable (default 1)
bit 2: configurable (default 1)
bit 3: accessor (0 = data, 1 = accessor with get/set)
```

### Implementation

**Phase 1: Storage**
- Add `$__prop_flags` field to every struct type: `(field $__prop_flags (ref $i8_array))`
- Each byte in the array holds flags for one property (indexed by field position)
- Default: `0b0111` (writable, enumerable, configurable, data)
- Initialize in struct.new with `array.new_fixed` of default flags

**Phase 2: Object.getOwnPropertyDescriptor**
- Compile as: look up field index by name → read flags byte → construct descriptor object
- Descriptor object is a struct with `{value, writable, enumerable, configurable, get, set}`
- For data properties: value = struct.get the field, writable/enumerable/configurable from flags
- For accessor properties: get/set from accessor function refs stored in separate fields

**Phase 3: Object.defineProperty**
- Update flags byte for the target field
- If changing value: struct.set
- If changing writable to false: update flag bit
- TypeError if not configurable and trying to change configurable/enumerable

**Phase 4: Object.freeze/seal/preventExtensions**
- freeze: set all fields to non-writable + non-configurable (clear bits 0,2)
- seal: set all fields to non-configurable (clear bit 2)
- preventExtensions: set a struct-level flag (add `$__extensible` i32 field, default 1)

### Standalone mode
All Wasm-native — no host imports needed. The flags array is a WasmGC i8 array, descriptor objects are structs.

## Files to modify
- `src/codegen/index.ts` — struct type registration (add flags field)
- `src/codegen/expressions.ts` — compile Object.getOwnPropertyDescriptor, Object.defineProperty, Object.freeze/seal
- `src/codegen/property-access.ts` — check writable flag before struct.set in strict mode

## Acceptance criteria
- Object.getOwnPropertyDescriptor returns correct descriptors for own properties
- Object.defineProperty modifies property attributes
- Object.freeze/seal/preventExtensions work
- 5,000+ test262 improvements

## Test Results (WI5 — freeze/seal runtime enforcement)

Branch: `worktree-issue-797-wi5-freeze-seal`

**Changes:**
- `src/runtime.ts`: `_wasmFrozenObjs`/`_wasmSealedObjs`/`_wasmNonExtensibleObjs` WeakSets; updated `_safeSet` to silently fail for sealed/non-extensible structs; fixed `_isWasmStruct` false-positive for sealed JS objects; new `__object_isFrozen/isSealed/isExtensible` host imports
- `src/codegen/expressions.ts`: `Object.isFrozen/isSealed/isExtensible` handlers with compile-time fast path + runtime delegation
- `tests/issue-797-wi5.test.ts`: 13 new tests, all passing

**test262 batch (6 freeze/seal/isExtensible/preventExtensions categories):**
- Baseline: 221 PASS / 86 FAIL / 11 SKIP
- After WI5: **222 PASS / 85 FAIL / 11 SKIP** (+1 net, no regressions)

## Test Results (WI 3, 6)

Smoke tests (5/5 pass):
- WI3: `Object.getOwnPropertyNames` host import — struct objects PASS
- WI3: `Object.getOwnPropertyNames` for dynamic externref objects PASS
- WI3: `Object.getOwnPropertySymbols` host import PASS
- WI6: `Object.getPrototypeOf` for Object.create result (dynamic externref) PASS
- WI6: `Object.create(proto, {x: {value:42}})` literal descriptor PASS

test262 batch (with setExports):
- `built-ins/Object/getOwnPropertyNames`: 19/45 PASS (+5 vs baseline)
- `built-ins/Object/create`: 81/320 PASS (getPrototypeOf fix advances assertions)
- `built-ins/Object/getOwnPropertySymbols`: 3/12 PASS
- `built-ins/Reflect/ownKeys`: 3/13 PASS

Branch: `issue-797-property-desc-batch2`, commit: `67daad01`.
