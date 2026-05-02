---
id: 1110
title: "Wrapper object constructors: new Number/String/Boolean (648 tests)"
status: done
created: 2026-03-11
updated: 2026-04-14
completed: 2026-03-20
priority: medium
feasibility: medium
task_type: feature
language_feature: wrapper-objects
goal: builtin-methods
renumbered_from: 123
test262_skip: 648
files:
  src/codegen/expressions.ts:
    new:
      - "compileWrapperConstructor — struct wrapping a primitive with __is_wrapper tag"
    breaking:
      - "typeof — branch on wrapper tag for object vs primitive"
---
# #1110 — Wrapper object constructors: new Number/String/Boolean (648 tests)

## Status: open (moved from wont-fix)

Previously labeled "won't implement" — reassessed as achievable via wrapper structs.

## Approach

`new Number(42)` compiles to a wrapper struct:
```
struct NumberWrapper {
  field $value f64
  field $__is_wrapper i32  // always 1
}
```

- `typeof wrapper === "object"` → check `__is_wrapper` tag
- `+wrapper` → `struct.get $value` (valueOf)
- `wrapper == 42` → unbox and compare
- `!!wrapper === true` → always truthy, even `new Boolean(false)`
- `wrapper === 42` → false (strict equality, different types)

TypeScript types help: `Number` (object) vs `number` (primitive) known at compile time.

## Complexity: M
