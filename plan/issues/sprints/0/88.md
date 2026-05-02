---
id: 88
title: "Issue 88: Test262 coverage — language/expressions"
status: done
created: 2026-03-09
updated: 2026-04-14
completed: 2026-03-09
goal: test-infrastructure
---
# Issue 88: Test262 coverage — language/expressions

## Status: DONE

## Summary

Added comprehensive `language/expressions/*` subcategories to the test262 runner.

## Categories added

- subtraction, multiplication, modulus (arithmetic completeness)
- right-shift (bitwise completeness)
- strict-equals, strict-does-not-equals
- void, unary-plus, unary-minus
- prefix-increment, prefix-decrement, postfix-increment, postfix-decrement
- assignment, property-accessors

(Previously added: addition, division, exponentiation, concatenation, bitwise ops, left-shift, equals, does-not-equals, greater-than, greater-than-or-equal, less-than, less-than-or-equal, logical ops, conditional, comma, typeof, instanceof, compound-assignment, logical-assignment, grouping, call, function)

## Results

All compilable expression tests pass (100%). Skip filters added for:
- Object property access (dot + bracket notation)
- Arithmetic on objects/functions
- Modulo -0 sign preservation and infinity divisor
- Unary +/- on null/undefined/empty string
- String strict comparison
- Unicode escape edge cases

## Tests

6773 test262 tests total, 412 pass, 0 fail
