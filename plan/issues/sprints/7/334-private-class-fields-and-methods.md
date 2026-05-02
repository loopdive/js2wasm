---
id: 334
title: "- Private class fields and methods"
status: done
created: 2026-03-13
updated: 2026-04-14
completed: 2026-04-14
priority: medium
goal: class-system
test262_ce: 15
test262_refs:
  - test/language/expressions/compound-assignment/left-hand-side-private-reference-method-add.js
  - test/language/expressions/compound-assignment/left-hand-side-private-reference-method-bitand.js
  - test/language/expressions/compound-assignment/left-hand-side-private-reference-method-bitor.js
  - test/language/expressions/compound-assignment/left-hand-side-private-reference-method-bitxor.js
  - test/language/expressions/compound-assignment/left-hand-side-private-reference-method-div.js
  - test/language/expressions/compound-assignment/left-hand-side-private-reference-method-exp.js
  - test/language/expressions/compound-assignment/left-hand-side-private-reference-method-lshift.js
  - test/language/expressions/compound-assignment/left-hand-side-private-reference-method-mod.js
  - test/language/expressions/compound-assignment/left-hand-side-private-reference-method-mult.js
  - test/language/expressions/compound-assignment/left-hand-side-private-reference-method-rshift.js
files:
  src/codegen/expressions.ts:
    breaking:
      - "compilePropertyAccess: resolve private field names (# prefix) to struct fields"
      - "compilePropertyAssignment: handle private field writes"
---
# #334 -- Private class fields and methods

## Status: open

15 test262 tests fail with "Unknown field privateMethod on struct" or similar errors when accessing private class members (fields, methods, accessors) via the `#name` syntax.

## Error pattern
- Unknown field private* on struct

## Likely causes
- Private field names (prefixed with #) not correctly mapped to struct field names
- Private method references not resolved during property access compilation
- Compound assignment on private fields fails because the field lookup does not match

## Complexity: M

## Acceptance criteria
- [ ] Reduce test262 failures matching this error pattern
