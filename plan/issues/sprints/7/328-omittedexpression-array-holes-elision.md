---
id: 328
title: "- OmittedExpression (array holes/elision)"
status: done
created: 2026-03-13
updated: 2026-04-14
completed: 2026-04-14
priority: low
goal: core-semantics
test262_ce: 15
test262_refs:
  - test/language/expressions/assignment/dstr/array-elem-init-assignment.js
  - test/language/expressions/function/dstr/ary-ptrn-elem-id-init-hole.js
  - test/language/expressions/arrow-function/dstr/ary-ptrn-elem-id-init-hole.js
  - test/language/expressions/array/11.1.4-0.js
  - test/language/statements/for/dstr/const-ary-ptrn-elem-id-init-hole.js
  - test/language/statements/for/dstr/let-ary-ptrn-elem-id-init-hole.js
  - test/language/statements/for/dstr/var-ary-ptrn-elem-id-init-hole.js
  - test/language/statements/variable/dstr/ary-ptrn-elem-id-init-hole.js
  - test/language/statements/try/dstr/ary-ptrn-elem-id-init-hole.js
  - test/language/statements/for-of/array.js
files:
  src/codegen/expressions.ts:
    breaking:
      - "compileArrayLiteral: handle OmittedExpression as undefined/hole"
  src/codegen/statements.ts:
    breaking:
      - "compileArrayDestructuring: skip OmittedExpression elements"
---
# #328 -- OmittedExpression (array holes/elision)

## Status: open

15 test262 tests fail with "Unsupported expression: OmittedExpression". Array holes (elisions) like `[1,,3]` and destructuring patterns with holes like `[a,,b] = arr` are not handled.

## Error pattern
- Unsupported expression: OmittedExpression

## Likely causes
- Array literal codegen does not handle omitted elements (holes)
- Destructuring patterns with elision elements not recognized

## Complexity: M

## Acceptance criteria
- [ ] Reduce test262 failures matching this error pattern
