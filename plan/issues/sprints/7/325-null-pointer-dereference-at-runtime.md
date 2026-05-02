---
id: 325
title: "- Null pointer dereference at runtime"
status: done
created: 2026-03-13
updated: 2026-04-14
completed: 2026-04-14
priority: medium
goal: crash-free
test262_fail: 32
test262_refs:
  - test/language/expressions/assignment/dstr/obj-rest-non-string-computed-property-1dot.js
  - test/language/expressions/assignment/dstr/obj-rest-non-string-computed-property-array-1.js
  - test/language/expressions/assignment/dstr/obj-rest-non-string-computed-property-array-1e0.js
  - test/language/statements/for/dstr/const-ary-ptrn-rest-id-direct.js
  - test/language/statements/for/dstr/const-ary-ptrn-rest-id-elision.js
  - test/language/statements/for/dstr/const-ary-ptrn-rest-id.js
  - test/language/statements/for/dstr/let-ary-ptrn-rest-id-direct.js
  - test/language/statements/for/dstr/let-ary-ptrn-rest-id-elision.js
  - test/language/statements/for/dstr/let-ary-ptrn-rest-id.js
  - test/language/statements/for/dstr/var-ary-ptrn-rest-ary-rest.js
files:
  src/codegen/expressions.ts:
    breaking:
      - "struct/array access: add null guards before dereference"
  src/codegen/statements.ts:
    breaking:
      - "destructuring: handle null intermediate values in rest patterns"
---
# #325 -- Null pointer dereference at runtime

## Status: open

32 test262 tests fail with "dereferencing a null pointer" at runtime. The compiled Wasm accesses a struct field or array element on a null reference.

## Error pattern
- RuntimeError: dereferencing a null pointer

## Likely causes
- Destructuring rest patterns on arrays that produce null intermediate values
- Missing null checks before struct field access
- Uninitialized variables used before assignment in for-loop destructuring

## Complexity: M

## Acceptance criteria
- [ ] Reduce test262 failures matching this error pattern
