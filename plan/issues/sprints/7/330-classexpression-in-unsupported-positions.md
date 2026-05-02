---
id: 330
title: "- ClassExpression in unsupported positions"
status: done
created: 2026-03-13
updated: 2026-04-14
completed: 2026-04-14
priority: medium
goal: compilable
test262_ce: 25
test262_refs:
  - test/language/expressions/assignment/fn-name-class.js
  - test/language/expressions/class/elements/private-getter-shadowed-by-field-on-nested-class.js
  - test/language/expressions/class/elements/private-getter-shadowed-by-getter-on-nested-class.js
  - test/language/expressions/class/elements/private-getter-shadowed-by-setter-on-nested-class.js
  - test/language/expressions/class/elements/private-method-shadowed-by-field-on-nested-class.js
  - test/language/expressions/class/elements/private-method-shadowed-by-setter-on-nested-class.js
  - test/language/expressions/class/elements/private-setter-shadowed-by-field-on-nested-class.js
  - test/language/expressions/class/elements/private-setter-shadowed-by-getter-on-nested-class.js
  - test/language/expressions/class/elements/private-setter-shadowed-by-method-on-nested-class.js
  - test/language/expressions/class/elements/private-setter-shadowed-by-setter-on-nested-class.js
files:
  src/codegen/expressions.ts:
    breaking:
      - "compileExpressionInner: handle ClassExpression as inline class definition"
  src/codegen/index.ts:
    breaking:
      - "collectDeclarations: recognize class expressions in more positions"
---
# #330 -- ClassExpression in unsupported positions

## Status: review

25 test262 tests fail with "Unsupported expression: ClassExpression". Class expressions used as values in assignment, nested class definitions, and private member shadowing contexts are not handled.

## Error pattern
- Unsupported expression: ClassExpression

## Likely causes
- Class expressions in assignment RHS not recognized
- Nested class expressions (class within class) not handled
- Private member shadowing across nested classes requires class expression support

## Complexity: M

## Acceptance criteria
- [x] Reduce test262 failures matching this error pattern
- [x] Class expressions in variable initializers work (const C = class { ... })
- [x] Named class expressions work (const C = class MyName { ... })
- [x] Class expressions with extends work
- [x] Class expressions inside function bodies work
- [x] Inline class expressions in new work (new (class { ... })())
- [x] Class expressions assigned via binary expression resolve via classExprNameMap

## Implementation Summary

### What was done
Two fixes to resolve ClassExpression in unsupported positions:

1. **`src/codegen/index.ts`**: When a binary assignment `C = class { ... }` is collected,
   the LHS identifier is now registered in `classExprNameMap` mapping it to the synthetic
   class name. Previously only the TS type symbol name was mapped, which fails for `any`-typed
   variables.

2. **`src/codegen/expressions.ts`**: In `compileNewExpression`, when looking up a class by
   identifier name (e.g., `new C()`), the code now also checks `classExprNameMap` as a
   fallback. Previously it only checked `classSet` directly, missing classes registered
   under synthetic names like `__anonClass_C_0`.

### What worked
- All 8 test cases pass covering: variable initializers, named class expressions, extends,
  function body classes, inline new expressions, multiple instances, no-constructor classes,
  and binary assignment with known types.

### What didn't
- Binary assignment with `any`-typed variable (`let C: any; C = class {...}; new C()`) still
  produces invalid Wasm due to type mismatch: the variable is `externref` but the struct
  constructor returns a ref type. This is a deeper type inference issue.
- Returning a class from a function and using it dynamically requires first-class class values,
  which is out of scope.

### Files changed
- `src/codegen/expressions.ts` — classExprNameMap lookup in compileNewExpression
- `src/codegen/index.ts` — register LHS identifier in classExprNameMap for binary assignments
- `tests/class-expression.test.ts` — 8 new test cases
