---
id: 1395
sprint: 51
title: "class static method descriptors: class identifier resolves to string_constant, not constructor object"
status: ready
created: 2026-05-09
priority: medium
feasibility: hard
reasoning_effort: max
task_type: feature
area: codegen
language_feature: class, static methods, property descriptors
goal: spec-completeness
depends_on: []
---
# #1395 — Static class identifier as constructor object

## Background

Filed from dev-1390-2 investigation of task #44 (2026-05-09).

`Object.getOwnPropertyDescriptor(C, "m")` for static method `m` on class `C` returns `null`
in the current compiler. Root cause: the class identifier `C` resolves to a string_constants
import (not a real constructor object), so the descriptor lookup has nothing to inspect.

WAT evidence (from dev-1390-2 probe):
```wat
(import "string_constants" "C" (global $C externref))
(func $getC (result externref) global.get 1 return)
```

## Current state

Instance method descriptors (`verifyProperty(c, "m", ...)`) work — the instance uses the
prototype chain and `_prototypeMethodNames` registry. Static method descriptors
(`verifyProperty(C, "m", ...)`) fail because `C` is a string import, not a real object.

## Required fix

1. **Class identifier as real object**: When a class `C` is defined, emit a proper
   constructor-object (not just the string name) that can be passed to host APIs.
   The constructor object must carry static method descriptors.

2. **Static method registry**: Analogous to `_prototypeMethodNames` for instance methods,
   introduce a `_staticMethodNames` registry keyed on the class constructor object.
   `__getOwnPropertyDescriptor` queries it when receiver is a recognized class object.

3. **Class reference resolution**: When `C` appears as an expression (not just a string),
   resolve to the constructor object, not the string_constants import.

## Scope relationship

- Distinct from #1394 (method-closure caching) which handles `C.prototype.m` identity.
- Both are about class boundary representation. Can proceed in parallel.
- This issue covers static methods. Instance method descriptor fidelity was mostly fixed
  in PR #310 (#1364) — but static descriptors are still broken.

## Test cluster

`test/language/statements/class/elements/after-same-line-*` tests using
`verifyProperty(C, "m", { value: ..., writable: true, configurable: true, enumerable: false })`.
~70 tests in this cluster.

## Files

- `src/codegen/index.ts` — class definition emission, emit constructor object + static method registry
- `src/runtime.ts` — `_staticMethodNames` registry + `__getOwnPropertyDescriptor` extension
- `src/codegen/expressions.ts` / `src/codegen/identifiers.ts` — resolve class identifier to object

## Investigation

Filed from dev-1390-2 (task #44, 2026-05-09). Two root causes for the 136-failure cluster:
1. This issue (static method descriptors) — ~70 fails
2. #1394 (method-closure caching, generator method identity) — remaining ~66 fails
