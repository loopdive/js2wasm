---
id: 375
title: "- Unsupported expression: SuperKeyword"
status: done
created: 2026-03-13
updated: 2026-04-14
completed: 2026-04-14
priority: medium
feasibility: medium
goal: compilable
test262_ce: 5
files:
  src/codegen/expressions.ts:
    new:
      - "compileSuperPropertyAccess — super.prop and super[expr] support"
    breaking: []
---
# #375 -- Unsupported expression: SuperKeyword

## Status: review

5+ tests fail to compile because the SuperKeyword expression is not handled in the codegen.

## Details

```javascript
class Parent {
  greet() { return 'hello'; }
}
class Child extends Parent {
  greet() {
    return super.greet() + ' world'; // super.prop access
  }
}
```

`super` in expressions can appear as:
1. `super.method()` -- call a parent class method
2. `super.prop` -- access a parent class property
3. `super[expr]` -- computed property access on parent

The compiler currently handles `super()` constructor calls but not `super` as a property access expression. Need to:
1. Resolve the parent class from the current class context
2. Compile `super.prop` as a lookup on the parent's prototype/struct
3. Handle `super.method()` by calling the parent's method with the current `this`

## Complexity: M

## Acceptance criteria
- [x] `super.method()` calls parent class method
- [x] `super.prop` accesses parent class property (getter accessors)
- [ ] `super[expr]` computed access works (deferred -- rarely used)
- [x] 7 previously failing compile errors resolved (test262 super/in-*.js tests)

## Implementation Summary

The implementation was done in commit `6ea648c5` (already on main). Two functions were added to `src/codegen/expressions.ts`:

1. **compileSuperMethodCall** (~line 9143): Handles `super.method()` calls by resolving the parent class via `ctx.classParentMap`, walking up the inheritance chain to find the method, and emitting a direct `call` with `this` as the first argument. This bypasses vtable dispatch to ensure the parent's implementation is called.

2. **compileSuperPropertyAccess** (~line 9218): Handles `super.prop` by:
   - Checking for parent getter accessors (walking up inheritance chain via `ctx.classAccessorSet`)
   - Falling back to struct field access on `this` (child struct inherits parent fields via WasmGC subtyping)

Both functions are dispatched from the PropertyAccessExpression handler (line 10897) and the CallExpression handler (line 7266) respectively, which check for `SyntaxKind.SuperKeyword` on the expression object.

### Files changed
- `src/codegen/expressions.ts` -- added compileSuperMethodCall, compileSuperPropertyAccess, dispatch hooks
- `tests/issue-375.test.ts` -- 6 dedicated tests for super.method() patterns
- `tests/equivalence/super-property-access.test.ts` -- 7 equivalence tests verifying Wasm matches JS output

### What worked
- Direct function call (bypassing vtable) for parent method dispatch
- Walking inheritance chain via `ctx.classParentMap` for multi-level super
- Getter accessor detection via `ctx.classAccessorSet`

### Known limitations
- `super[expr]` (computed element access on super) is not yet handled
- `super.prop` for instance fields returns the struct field value, while JS returns `undefined` (semantic difference in prototype-based vs struct-based inheritance)
