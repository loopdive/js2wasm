---
id: 739
title: "- Object.defineProperty correctness (262 tests)"
status: ready
created: 2026-03-22
updated: 2026-04-28
priority: medium
feasibility: hard
reasoning_effort: max
goal: property-model
test262_fail: 262
files:
  src/codegen/expressions.ts:
    new:
      - "Object.defineProperty implementation with full descriptor support"
---
# #739 -- Object.defineProperty correctness (262 tests)

## Status: backlog

## ECMAScript spec reference

- [§20.1.2.4 Object.defineProperty](https://tc39.es/ecma262/#sec-object.defineproperty) — step 3: call DefinePropertyOrThrow
- [§10.1.6.3 ValidateAndApplyPropertyDescriptor](https://tc39.es/ecma262/#sec-validateandapplypropertydescriptor) — complete validation logic for descriptor compatibility, accessor vs. data conversion


## Problem

262 tests under built-ins/Object/defineProperty and built-ins/Object/defineProperties fail. The compiler's Object.defineProperty implementation is either missing or incomplete.

### ES spec requirements
- Data descriptors: value, writable, enumerable, configurable
- Accessor descriptors: get, set, enumerable, configurable
- Descriptor validation (cannot mix data + accessor)
- Respect existing configurability (non-configurable properties cannot be reconfigured)
- DefineOwnProperty must follow the spec algorithm exactly

### What needs to happen

1. Implement full Object.defineProperty with descriptor validation
2. Object struct must store property attributes (writable, enumerable, configurable)
3. Implement Object.defineProperties as multi-call wrapper
4. Implement Object.getOwnPropertyDescriptor to read attributes back

## Complexity: L (>400 lines, fundamental object model change)
