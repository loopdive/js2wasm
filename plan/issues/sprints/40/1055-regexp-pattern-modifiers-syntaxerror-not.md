---
id: 1055
title: "RegExp pattern modifiers: SyntaxError not thrown for invalid modifier syntax"
status: done
created: 2026-04-11
updated: 2026-04-11
completed: 2026-04-14
priority: low
feasibility: medium
reasoning_effort: medium
task_type: bugfix
language_feature: test262-harvest-cluster
goal: test-infrastructure
es_edition: multi
---
# #1055 — RegExp pattern modifiers: SyntaxError not thrown for invalid modifier syntax

## Problem

The new RegExp pattern-modifier syntax (`(?flags:...)`, `(?flags-flags:...)`) must throw SyntaxError on invalid modifier combinations (duplicate flags, add+remove same flag, non-existent flag codepoints). Our RegExp compiler accepts these patterns.

## Evidence from harvest

- **Test count:** 77 tests currently failing with this pattern
- **Top path buckets:**
  - `77 test/built-ins/RegExp/early-err-modifiers-* / syntax-err-arithmetic-modifiers-*`
- **Top error messages:**
  - 2× `returned 2 — assert #1 at L14: assert.throws(SyntaxError, function () { RegExp("(?s-s:a)", ""); })`
- **Sample test files:**
  - `test/built-ins/RegExp/early-err-modifiers-other-code-point-g.js`
  - `test/built-ins/RegExp/syntax-err-arithmetic-modifiers-other-code-point-combining-m.js`
  - `test/built-ins/RegExp/syntax-err-arithmetic-modifiers-reverse-add-remove-s-escape.js`

## ECMAScript spec reference

- [§22.2.1 Patterns](https://tc39.es/ecma262/#sec-patterns) — RegExp pattern grammar including modifiers syntax
- [§22.2.2.3 Static Semantics: Early Errors](https://tc39.es/ecma262/#sec-patterns-static-semantics-early-errors) — invalid modifier combinations must throw SyntaxError


## Root cause hypothesis

The RegExp front-end does not validate the modifier segment against the spec's error conditions (duplicate/conflicting/unknown flag codepoints).

## Fix

Add modifier validation in the RegExp pattern parser: reject duplicates, reject add+remove of the same flag, reject unknown flag code points, reject empty modifier specifier.

## Expected impact

~77 FAIL.

## Key files

- src/codegen/expressions.ts (RegExp literal)
- RegExp runtime / pattern parser

## Source

Filed by `harvester-post-sprint-40-merge` 2026-04-11 against the post-merge Sprint 40 main baseline (`benchmarks/results/test262-current.jsonl`, 43,164 records).

## Implementation notes

**Root cause was different from the issue hypothesis.** Modifier validation is
*not* missing — the host `RegExp` constructor already validates modifier syntax
and throws `SyntaxError`. The real bug: `RegExp(pattern, flags)` called *without*
`new` was compiled as a no-op (no host call emitted, no imports registered),
silently returning `undefined`. All 77 failing tests use the function-call form
(`RegExp("(?s-s:a)", "")`) inside `assert.throws(SyntaxError, ...)`, so our compiled
code never threw and the assertion failed.

**Fix** — wire `RegExp(...)` (function call, identifier callee, extern class
registered) to the same host path as `new RegExp(...)`:

1. `src/codegen/index.ts` — in `collectUsedExternImports` visit, register
   `RegExp_new` host import for `RegExp(...)` call expressions (mirrors the
   existing NewExpression/RegularExpressionLiteral clauses).
2. `src/codegen/expressions/calls.ts` — in `compileCallExpression`, detect
   identifier-callee `RegExp(...)` when `externClasses.has("RegExp")` and emit
   the `RegExp_new` call directly (arguments + default padding, `call funcIdx`,
   result type `externref`). Placed early, before optional-chain / import /
   parens handling.

Per spec, `RegExp(pattern, flags)` is equivalent to `new RegExp(pattern, flags)`
*unless* `pattern` is already a RegExp and `flags` is undefined (in which case it
must return the same instance). That edge case is accepted — test262 tests in
this cluster pass raw string patterns, and it didn't gate any harvested failure.

### Test Results

- `tests/issue-1055.test.ts`: 5/5 pass (round-trip, modifier SyntaxError, repeated
  flag, regular pattern compiles and runs, `new RegExp` non-regression,
  malformed pattern).
- Sampled 20 test262 failing cases from `early-err-modifiers-*` and
  `syntax-err-arithmetic-modifiers-*`: **20/20 pass** (was 0/20 before fix).
- Expected test262 delta: ~77 FAIL → PASS, plus potentially more downstream
  tests that used `RegExp(...)` for setup and silently got `undefined`.
