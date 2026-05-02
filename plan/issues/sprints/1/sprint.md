# Sprint 1

**Date**: 2026-03-11 (morning)
**Goal**: First test262 conformance push — language feature coverage
**Baseline**: 550 pass (100% of compilable tests at the time)

## Issues
- #116-#129 — Test262 harness improvements and issue backlog
- #119-#128 — BigInt, private class members, arguments, valueOf/toString, assert.throws, undefined
- #130 — Usage-based shape inference and Array.prototype.X.call() inlining
- #131-#136 — String concat, switch fallthrough, ternary values, loose equality, typeof
- #137 — Object literal getter/setter and method support
- #138, #139 — valueOf coercion on comparison, equality, and arithmetic operators
- #140 — Bracket access on struct types and computed accessor names
- #141 — Tagged template excess substitutions
- #142 — Assignment destructuring codegen
- #143, #165 — Function declaration hoisting, IIFE support, default params for nested functions
- #144 — new FunctionExpression(args) with spread and arguments
- #145 — Void-to-number coercion for allowJs type flexibility
- #148 — String-literal bracket notation on structs
- #150, #151 — ClassDeclaration in statement positions, noImplicitThis suppression
- #152 — Setter return value diagnostic suppression
- #154, #162, #163, #164 — Switch case type matching, skip filters for IIFEs/indirect eval
- #155, #156, #157 — Logical-and/or short-circuit correct operand value
- #158, #160, #161 — Boolean-to-string coercion, string+= import, skip filter precision
- #159 — IIFE support and extra argument handling
- #166-#168 — typeof null/undefined and in operator with dynamic/numeric keys
- #169-#172 — IIFE support, Boolean string truthiness, class-in-function, bool assertions

## Results
**Final numbers**: 1,509 pass / ~23,000 total
**Delta**: +959 pass (+174% from 550)
**Equivalence tests**: 86 → 170

## Notes
- Massive single-session push covering ~35 issues
- 90% compilable rate achieved
- First structured sprint with parallel agent development

<!-- GENERATED_ISSUE_TABLES_START -->
## Issue Tables

_Generated from issue files. Update issue `status`, then rerun `node scripts/sync-sprint-issue-tables.mjs`._

### Done

| Issue | Title | Priority | Status |
|---|---|---|---|
| #100 | Issue #100: Mutable closure captures via ref cells |  | done |
| #101 | Issue 101: Test262 — language/statements remaining |  | done |
| #102 | Issue 102: Test262 — language/expressions remaining |  | done |
| #103 | Issue 103: Test262 — built-ins/String prototype methods |  | done |
| #104 | Issue 104: Test262 — language/ top-level categories |  | done |
| #105 | Issue 105: Test262 — built-ins/Map, built-ins/Set, built-ins/Promise |  | done |
| #106 | Issue 106: Test262 — built-ins/Object extended + built-ins/Array constructor |  | done |
| #107 | Issue 107: Fix codegen null-dereference crashes (90 occurrences) |  | done |
| #108 | Issue 108: String(), Boolean(), Array() as global conversion functions |  | done |
| #109 | Issue 109: Tagged template literals |  | done |
| #110 | Issue 110: `in` operator for property existence test |  | done |
| #111 | Issue 111: Missing ES2015+ Math methods |  | done |
| #112 | Issue 112: Number static methods and constants (ES2015) |  | done |
| #113 | Issue 113: Bug — 'Object literal type not mapped to struct' |  | done |
| #114 | Issue 114: Bug — 'Codegen error: vec data field not ref' |  | done |
| #115 | Issue 115: Bug — while/do-while loop internal variable scope crash |  | done |
| #144 | Issue #144: new expression with class expressions | low | done |
| #145 | Issue #145: allowJs type flexibility — boolean/string/void as number | low | done |
| #148 | Issue #148: Element access (bracket notation) on struct types | low | done |
| #150 | ClassDeclaration in statement positions | low | done |
| #151 | `this` keyword in class methods for test262 | low | done |
| #154 | Issue #154: while/do-while loop condition evaluation | low | done |
| #155 | Logical-and/logical-or short-circuit returns wrong value | low | done |
| #156 | Conditional (ternary) expression evaluation | low | done |
| #157 | void expression returns wrong value | low | done |
| #158 | String concatenation with non-string operands | low | done |
| #159 | Call expression edge cases | low | done |
| #160 | Math method edge cases | low | done |
| #161 | Compound assignment edge cases | low | done |
| #162 | Issue #162: switch statement matching | low | done |
| #163 | Issue #163: return statement edge cases | low | done |
| #164 | Issue #164: variable declaration edge cases | low | done |
| #166 | `in` operator runtime failures | low | done |
| #168 | equality operators with null/undefined | low | done |
| #169 | Arrow function edge cases | low | done |
| #172 | Array.isArray edge case | low | done |

### Won't Fix

| Issue | Title | Priority | Status |
|---|---|---|---|
| #123 | Wrapper object constructors (new Number/String/Boolean) |  | wont-fix |
| #124 | delete operator |  | wont-fix |
| #125 | Object.defineProperty / property descriptors |  | wont-fix |
| #129 | propertyHelper.js test262 harness include |  | wont-fix |

<!-- GENERATED_ISSUE_TABLES_END -->
