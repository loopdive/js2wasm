---
id: 1349
sprint: 50
title: "spec gap: class static initialization order + private field semantics (significant share of 1500+ class fails)"
status: ready
created: 2026-05-08
priority: high
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: class
goal: spec-completeness
parent: 1328
---
# #1349 — Class: static block order, private field exotics, super-class field shadow

## Problem

`language/expressions/class`: **2755 / 4059 pass (67.9%) — 1301 fails (666 assertion_fail,
256 runtime_error, 205 type_error, 103 wasm_compile, 39 other)**.
`language/statements/class`: **2874 / 4367 pass (65.8%) — 1489 fails (850 assertion_fail,
221 runtime_error, 207 type_error, 107 wasm_compile, 48 other)**.

Combined ~2,790 class-related failures. Major sub-categories:

1. **Static initialization order** (§15.7.10): class static fields, methods, and `static {}` blocks
   must run in source order during class evaluation, with private statics installed before public
   methods. We currently process them all "after" the constructor, observable via field access from
   a static block.
2. **Private fields** (§15.7.7): each instance carries a fresh PrivateName slot per class
   declaration. Re-reading after deletion throws TypeError. Private brand check on `obj.#x` must
   throw TypeError if the object isn't an instance of the declaring class.
3. **Super-class field shadow**: when a subclass has a same-named instance field, the spec requires
   the superclass to install its field first, then the subclass overwrites. We currently skip the
   superclass install when the subclass redeclares.
4. **Computed property names with side-effects** (#1239): the [[Get]] of a computed name may have
   side-effects that must be observed once.

## Acceptance criteria

1. `language/statements/class/static-init-order-of-eval.js` passes.
2. `language/expressions/class/elements/private-field-as-instance.js` passes.
3. `language/statements/class/subclass/built-ins/Array/super-must-be-called-1.js` passes.
4. wasm_compile errors in `language/statements/class` drop from 107 to <30.
5. Pass-rate for `language/statements/class` rises from 66% to ≥80%.

## Files to modify

- `src/codegen/class-bodies.ts` — class member compilation order
- `src/codegen/expressions.ts` — private field access (`obj.#x`)
- `src/codegen/declarations.ts` — class declaration emission

## Implementation Plan

### Root cause

Multiple intertwined issues. Recommend splitting into three sub-tasks:

1. **Static initialization order**: scan class-body in source order; emit a single
   `__class_init_$N` function that runs each member's initializer in the right slot.
2. **Private fields**: model each `#x` as an additional struct field on the instance,
   with a hidden brand-check (`ref.test $ClassBrandX`) at every access site. TypeError
   on missing brand.
3. **Super shadow**: when extending a parent class, walk parent's field declarations during
   constructor compilation; emit each (whether or not the child redeclares).

Each sub-task is medium-sized; consider creating sub-issues if devs prefer.

### Edge cases

- `static {}` block can reference earlier static fields but not later ones — emit a hoisting
  guard that raises ReferenceError on TDZ access.
- Private field on a class expression vs class declaration — same brand semantics.
- `class C extends null` — super constructor is null; valid per spec, super() throws TypeError.

### Test262 sample

- `test262/test/language/statements/class/static-init-order-of-eval.js`
- `test262/test/language/expressions/class/elements/private-field-as-instance.js`
- `test262/test/language/statements/class/subclass/builtin-objects/Array/super-must-be-called-1.js`
- `test262/test/language/statements/class/static-block-private-name.js`
