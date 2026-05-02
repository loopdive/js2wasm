---
id: 1273
title: "instanceof across compilation boundaries"
status: in-progress
created: 2026-05-02
updated: 2026-05-02
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: feature
area: codegen
language_feature: instanceof, classes
goal: npm-library-support
related: [1244]
---

## Implementation note (2026-05-02, dev-1245)

Same stale-issue pattern as #1250, #1271, #1272, #1275, #1276 — the
documented acceptance criteria already pass on origin/main:

```
class Foo {}; new Foo() instanceof Foo            → true ✓
class Bar extends Foo {}; new Bar() instanceof Foo → true ✓
{} instanceof Foo                                  → false ✓
new Bar() instanceof Bar                           → true ✓
new Baz() instanceof Foo (unrelated class)         → false ✓
multi-level: new C() instanceof A (C ⊂ B ⊂ A)      → true ✓
new Foo() instanceof Bar (parent NOT instanceof child) → false ✓
```

The compiler routes instanceof through struct-tag / ref.test-style
dispatch on compiled classes — the approach the issue spec proposes.

PR is therefore test-only. Adds `tests/issue-1273.test.ts` with 7
regression tests covering:
1. instanceof same class
2. instanceof inheritance (one-level)
3. instanceof non-class object → false
4. instanceof on fresh instance of own class
5. instanceof unrelated class → false
6. multi-level inheritance: deep subclass instance is instance of root parent
7. Reverse direction: parent instance is NOT instance of subclass

---

# #1273 — `instanceof` across compilation boundaries

## Problem

`c instanceof Context` where `Context` is a class compiled to a WasmGC struct currently
either returns `false` always or throws. Hono uses `instanceof` to check if a value is a
`Context` object at middleware boundaries.

## Root cause

WasmGC struct types have no prototype chain. `instanceof` in JS checks `obj.__proto__`
against `Class.prototype`. Compiled structs don't expose a prototype.

## Approach

For each compiled class, emit a struct type tag — an i32 type ID stored as the first field
of every struct instance. `instanceof T` compiles to: read the tag field, compare against
T's known tag ID. For inheritance, check the full ancestor chain of tag IDs.

This is already done for some internal runtime checks; needs to be exposed to user-level
`instanceof` expressions.

## Acceptance criteria

1. `class Foo {}; const f = new Foo(); f instanceof Foo` → true
2. `class Bar extends Foo {}; new Bar() instanceof Foo` → true (inheritance)
3. `{} instanceof Foo` → false (non-class object)
4. `tests/issue-1273.test.ts` covers all three
5. No regression in class tests
