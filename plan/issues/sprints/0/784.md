---
id: 784
title: "- Expected SyntaxError but compiled successfully (~2,657 tests)"
status: done
created: 2026-03-25
updated: 2026-04-14
completed: 2026-03-25
priority: medium
feasibility: hard
goal: error-model
parent: 779
test262_fail: 2657
---
# #784 -- Expected SyntaxError but compiled successfully (~2,657 tests)

## Problem

Tests expect the source code to be rejected at parse time with a `SyntaxError`, but our compiler (which delegates to TypeScript's parser) accepts the code and compiles it to Wasm. The test then runs and the harness reports failure because no parse error was thrown.

This is fundamentally a parser-level issue: TypeScript's parser is more permissive than the ECMAScript spec requires in several areas.

## Breakdown by sub-pattern

| Pattern | Count |
|---------|-------|
| (truncated/no description) | 623 |
| `await` as identifier in generators/async | 150 |
| `yield` as identifier in generators | 104 |
| Rest element with trailing comma | 172 |
| Rest element with initializer | 172 |
| `arguments`/`super()` in class fields | 116 |
| `delete` on identifier in strict mode | 54 |
| Strict mode reserved words | ~52 |
| Duplicate binding in strict mode | ~50 |
| RegExp syntax errors | ~50 |
| Other | ~1,114 |

## Breakdown by category

| Category | Count |
|---------|-------|
| language/statements | 1,032 |
| language/expressions | 976 |
| built-ins/RegExp | 192 |
| language/literals | 173 |
| language/module-code | 132 |
| language/block-scope | 67 |
| language/future-reserved-words | 18 |
| Other | ~67 |

## Sample test files

- `test/language/expressions/class/async-gen-method/yield-as-identifier-reference.js` — yield as identifier in async generator
- `test/language/statements/class/dstr/meth-ary-ptrn-rest-init-ary.js` — rest element with initializer
- `test/language/statements/const/dstr/ary-ptrn-rest-init-obj.js` — rest with initializer in const
- `test/language/statements/return/S12.9_A1_T2.js` — return outside function
- `test/language/module-code/parse-err-decl-pos-export-for-in-const.js` — invalid export position
- `test/built-ins/RegExp/early-err-modifiers-other-code-point-u.js` — RegExp early error
- `test/language/expressions/object/method-definition/escaped-get-e.js` — escaped keyword
- `test/language/asi/S7.9.2_A1_T6.js` — ASI edge case

## Fix approach

1. **Pre-compilation validation pass** — add a custom validation pass after TypeScript parsing that checks for ECMAScript-specific early errors:
   - Rest element cannot have initializer
   - Rest element cannot have trailing comma
   - `yield`/`await` as identifiers in generator/async contexts
   - `delete` on unqualified identifier in strict mode
   - Duplicate parameter names in strict mode
2. **RegExp validation** — validate RegExp patterns against ECMAScript spec (not just V8 behavior)
3. **Strict mode enforcement** — TypeScript doesn't enforce all strict mode early errors
4. **Consider skip filter** — some of these (like TypeScript accepting `yield` as identifier) may be intentional TS behavior; could add skip filters for tests that test parser strictness beyond what TS enforces

## Files to modify

- `src/codegen/index.ts` — add pre-compilation validation pass
- `src/codegen/expressions.ts` — RegExp literal validation
- `tests/test262-harness.ts` — potentially add skip filters for TS-parser-permissiveness tests
