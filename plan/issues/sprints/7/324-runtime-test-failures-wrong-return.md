---
id: 324
title: "- Runtime test failures (wrong return values)"
status: done
created: 2026-03-13
updated: 2026-04-14
completed: 2026-04-14
priority: high
goal: compilable
test262_fail: 396
test262_refs:
  - test/built-ins/Math/min/Math.min_each-element-coerced.js
  - test/built-ins/Math/max/Math.max_each-element-coerced.js
  - test/built-ins/Math/pow/applying-the-exp-operator_A1.js
  - test/built-ins/Math/pow/applying-the-exp-operator_A13.js
  - test/built-ins/Math/pow/applying-the-exp-operator_A21.js
  - test/built-ins/Math/atanh/atanh-specialVals.js
  - test/built-ins/Math/expm1/expm1-specialVals.js
  - test/built-ins/Math/log2/log2-basicTests.js
  - test/built-ins/Math/log10/Log10-specialVals.js
  - test/language/expressions/addition/S11.6.1_A2.1_T1.js
files:
  src/codegen/expressions.ts:
    breaking:
      - "operator implementations: fix runtime correctness for arithmetic, comparison, and coercion"
  src/codegen/index.ts:
    breaking: []
---
# #324 -- Runtime test failures (wrong return values)

## Status: open

Many test262 tests compile and run but produce incorrect results (wrong numeric values, false instead of true, etc.). These are runtime correctness bugs spread across many categories including Math builtins, expressions, and statements.

## Error patterns
- Tests return 0 or NaN instead of expected values
- Boolean expression tests return false instead of true
- Arithmetic/comparison operations produce wrong results

## Likely causes
- Missing or incorrect type coercions at runtime
- Incorrect operator semantics (e.g., abstract equality, relational comparisons with coercion)
- Math builtin edge cases (special values, boundary conditions)
- String-to-number or object-to-primitive coercion missing

## Complexity: M

## Acceptance criteria
- [ ] Reduce test262 failures matching this error pattern
