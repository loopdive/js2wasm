---
id: 845
title: "Miscellaneous compile errors: object literals, RegExp-on-X, for-in/of edge cases (340 CE)"
status: done
created: 2026-03-28
updated: 2026-04-14
completed: 2026-04-14
priority: medium
feasibility: hard
goal: error-model
test262_ce: 340
---
# #845 -- Miscellaneous compile errors (340 CE)

## Problem

340 compile errors fall outside the major categorized patterns. These are grouped into smaller sub-patterns below.

## Sub-pattern breakdown

| Sub-pattern | Count | Error message pattern |
|-------------|-------|-----------------------|
| TS parse errors (redeclare, syntax) | ~60 | `Cannot redeclare block-scoped variable`, `Declaration or statement expected`, hashbang |
| Object literal struct mapping | 36 | `Cannot determine struct type for object literal` (20), `Object literal type not mapped to struct` (16) |
| FunctionExpression with spread | 18 | `new FunctionExpression with non-literal spread not supported` |
| Element access errors | 18 | `An element access expression should take an argument` (14), `Element access on non-array value` (4) |
| Missing RegExp method imports | 22 | `Missing import for method: RegExp_hasOwnProperty` (13), `RegExp_toString` (9) |
| Lexical declaration context | 12 | `Lexical declaration cannot appear in a single-statement context` |
| Stack overflow in compiler | 8 | `Maximum call stack size exceeded` |
| for-of/for-in edge cases | 13 | `for-of requires an array expression` (7), `for-in variable must be...` (6) |
| Destructuring edge cases | 10 | `Cannot destructure: not an array type` (6), `Unknown field in destructuring` (4) |
| Internal compiler crashes | 11 | `Cannot read properties of undefined`, `compileOptionalDirectCall is not defined` |
| super edge cases | covered in #843 | -- |
| Duplicate identifier | 4 | `Duplicate identifier '__func'` |
| Invalid character / parse | 12 | `Invalid character`, `',' expected`, `Unexpected keyword` |
| Other small patterns | ~20 | Various one-off errors |

## Sample files with exact errors

### 1. Cannot determine struct type for object literal

**File**: `test/language/expressions/array/spread-err-mult-err-obj-unresolvable.js`
**Error**: `L37:4 Cannot determine struct type for object literal`
**Source** (line 37):
```js
var a = [0, 1, ...{0: 'a', 1: 'b', length: 2}];
```
Spread of an object literal with numeric keys -- not a known struct shape.

### 2. Object literal type not mapped to struct

**File**: `test/language/expressions/array/spread-mult-obj-null.js`
**Error**: `L43:16 Object literal type not mapped to struct`

### 3. Missing RegExp method import

**File**: `test/built-ins/Array/prototype/indexOf/15.4.4.14-1-12.js`
**Error**: `L13:23 Missing import for method: RegExp_indexOf`
**Source** (lines 11-13):
```js
var obj = new RegExp();
obj.length = 2;
obj[1] = true;
```
Array.prototype.indexOf called with RegExp object as `this` -- compiler tries to look up `indexOf` on RegExp extern class.

### 4. Lexical declaration in single-statement context

**File**: Various `test/language/statements/` files
**Error**: `Lexical declaration cannot appear in a single-statement context`
This is a valid ES strict-mode restriction, but some tests are testing the error itself (negative tests that expect SyntaxError).

### 5. for-of requires array expression

**File**: Various `test/language/statements/for-of/` files
**Error**: `for-of requires an array expression`
Non-array iterables (strings, Maps, Sets, generators) in for-of loops.

## Root cause

Multiple codegen files are involved:
- `src/codegen/expressions.ts`: Object literal struct resolution, element access, spread
- `src/codegen/statements.ts`: for-of/for-in handling, lexical declarations
- `src/codegen/index.ts`: Method import resolution, struct type mapping

These are numerous small gaps rather than a single root cause. Many are edge cases of existing features that need broader support.

## Suggested approach

Address in priority order:
1. Object literal struct mapping (36 CE) -- extend struct type inference for ad-hoc object shapes
2. Missing RegExp method imports (22 CE) -- register RegExp as full extern class with common methods
3. FunctionExpression with spread (18 CE) -- handle spread in new FunctionExpression args
4. Element access errors (18 CE) -- handle missing index in element access, non-array element access
5. for-of/for-in edge cases (13 CE) -- support non-array iterables in for-of

## Acceptance criteria

- Top 5 sub-patterns addressed (100+ CE eliminated)
- Internal compiler crashes caught with better diagnostics
