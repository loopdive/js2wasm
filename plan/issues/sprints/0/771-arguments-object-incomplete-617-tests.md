---
id: 771
title: "- Arguments object incomplete (~617 tests)"
status: done
created: 2026-03-22
updated: 2026-04-14
completed: 2026-03-26
priority: high
feasibility: medium
goal: core-semantics
commit: cd7b2a7a, 194c1d33
test262_fail: 617
files:
  src/codegen/expressions.ts:
    modify:
      - "compileIdentifier — handle 'arguments' reference"
  src/codegen/index.ts:
    modify:
      - "FunctionContext — add arguments array creation"
      - "compileFunctionBody — emit arguments object setup"
---
# #771 -- Arguments object incomplete (~617 tests)

## Problem

617 test262 tests fail because the `arguments` object implementation is incomplete. Tests check properties like `arguments.length`, `arguments[n]`, and whether arguments is writable/configurable/enumerable.

## Implementation hints

- The `arguments` object should be a JS-like array-backed object with `.length` and indexed access
- Create it at function entry: allocate an array, copy params into it
- `arguments.length` → array length, `arguments[i]` → array element access
- Arrow functions do NOT have their own `arguments` — they inherit from enclosing function
- Sloppy mode: arguments aliases parameters (mutation reflects). Strict mode: arguments is a copy.
- Start with strict mode (copy) — it's simpler and covers most test262 tests

## Key constraint

- Touch `compileIdentifier` in expressions.ts for the `arguments` reference
- Touch `compileFunctionBody` / FunctionContext in index.ts for setup
- Do NOT touch `compilePropertyAccess` or `compileElementAccess` — those are #775's territory

## Acceptance criteria

- arguments.length returns correct count
- arguments[i] returns the ith parameter
- Arrow functions inherit outer arguments
- ~617 tests improve, no regressions

## Implementation notes

The core problem was that `compileFunctionBody` in `src/codegen/index.ts` created the
arguments vec struct using `f64` elements (or `i32` in fast mode). This caused all
non-numeric parameters (strings, objects, etc.) to be dropped and replaced with `0`,
making `arguments[i]` return incorrect values for non-numeric args.

The fix switches the arguments vec to use `externref` elements, matching the approach
already used in `closures.ts` for function expressions and in `expressions.ts` for IIFEs.
Numeric parameters are boxed via `__box_number`, and ref types are converted via
`extern.convert_any`.

This primarily addresses the 169 WebAssembly.Exception trap failures in the
`language/arguments-object` test262 category, which were caused by type mismatches
when accessing string/object arguments through an f64-backed array.

Changes:
- `src/codegen/index.ts`: Changed `compileFunctionBody` arguments vec from f64 to
  externref elements, with proper boxing for numeric params. Added import of
  `ensureLateImport` and `flushLateImportShifts` from expressions.ts.
- `tests/issue-771.test.ts`: Added 6 tests covering arguments.length, arguments[i],
  zero params, function expressions, string params, and strict-mode non-aliasing.
- No regressions: equivalence tests show identical pass/fail counts (1049/53).
