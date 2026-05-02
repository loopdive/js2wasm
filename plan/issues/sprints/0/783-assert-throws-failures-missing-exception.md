---
id: 783
title: "- assert.throws failures: missing exception throwing (~3,293 tests)"
status: done
created: 2026-03-25
updated: 2026-04-14
completed: 2026-03-25
priority: high
feasibility: medium
goal: error-model
parent: 779
test262_fail: 3293
---
# #783 -- assert.throws failures: missing exception throwing (~3,293 tests)

## Problem

Tests expect a specific exception to be thrown (via `assert.throws(ErrorType, fn)`) but the code either:
1. Runs successfully without throwing (most common), or
2. Throws the wrong error type

These tests exercise error-checking code paths that are missing from the compiler output.

## Breakdown by expected error type

| Expected Error | Count |
|---------------|-------|
| TypeError | ~1,200 |
| Test262Error | ~600 |
| RangeError | ~380 |
| ReferenceError | ~500 |
| SyntaxError | ~280 |
| Other (DummyError, custom) | ~333 |

## Common sub-patterns

- **TypeError from method on wrong `this`** (~400): `Array.prototype.map.call(null, fn)` should throw TypeError
- **TypeError from non-callable** (~200): passing non-function where callback expected
- **ReferenceError from undeclared variable** (~300): `eval("x += 1")` for undeclared `x`, strict mode assignment to undeclared
- **RangeError from invalid arguments** (~300): `new Array(-1)`, `toString(37)`, invalid Date
- **TypeError from frozen/sealed objects** (~200): writing to non-writable property, extending non-extensible object
- **TypeError from non-object destructuring** (~100): `{} = null`, `[] = undefined`
- **Test262Error from custom throw** (~600): test code explicitly throws, expects it to propagate

## Sample test files

- `test/language/arguments-object/10.5-1-s.js` — strict mode arguments assignment
- `test/language/statements/class/definition/constructable-but-no-prototype.js` — class without prototype
- `test/built-ins/Array/prototype/flat/target-array-non-extensible.js` — Array.flat on non-extensible
- `test/built-ins/DataView/prototype/setFloat32/return-abrupt-from-tonumber-value.js` — DataView type coercion
- `test/built-ins/JSON/stringify/space-string-object.js` — JSON.stringify with object space
- `test/built-ins/RegExp/early-err-modifiers-other-code-point-u.js` — RegExp early error
- `test/built-ins/Temporal/Instant/prototype/until/instant-string.js` — Temporal validation
- `test/language/expressions/logical-assignment/lgcl-nullish-assignment-operator-non-writeable-put.js` — nullish assign to non-writable

## Fix approach

1. **Type-checking guards** — emit `ref.test` + `br_if` to throw TypeError when `this` is wrong type for built-in methods
2. **Callable checks** — before `call_ref`, verify the value is actually a function reference
3. **ReferenceError for undeclared** — strict mode must throw ReferenceError on assignment to undeclared variables
4. **RangeError validation** — add bounds checking in Array constructor, Number.prototype.toString radix, etc.
5. **Property descriptor enforcement** — check writable/configurable/extensible flags before property writes

## Files to modify

- `src/codegen/expressions.ts` — call expressions (callable check), property assignment (writable check)
- `src/codegen/statements.ts` — strict mode checks, variable declaration validation
- `src/codegen/index.ts` — built-in method `this` validation, Array/Number constructor validation
