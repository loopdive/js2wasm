---
id: 1389
sprint: 51
title: "fix: false CE — var + function-declaration same name at top-level scope"
status: done
created: 2026-05-08
priority: medium
feasibility: easy
reasoning_effort: low
task_type: bugfix
area: compiler/validation
language_feature: var, hoisting
goal: spec-completeness
---
# #1389 — False CE: `var x; function x(){}` at top-level scope

## Problem

~60 tests fail with:

```
CE: Cannot redeclare block-scoped variable 'smoosh'
```

Example failing tests:
```
language/expressions/dynamic-import/syntax/valid/nested-arrow-assignment-expression-import-source-script-code-valid.js
language/expressions/dynamic-import/syntax/valid/nested-function-script-code-valid.js
```

Both contain `var smoosh; function smoosh() {}` at the top level — valid script code per §13.1.1 (LexicallyDeclaredNames does not include VarDeclaredNames at script level).

## Root cause

`checkVarLexicalConflicts` at `src/compiler/validation.ts:2588` collects lexical names and flags `var` declarations that collide. At line 2601-2602 it adds **all** function declarations to `lexicalNames`:

```ts
} else if (ts.isFunctionDeclaration(stmt) && stmt.name) {
  lexicalNames.add(stmt.name.text);
}
```

This is correct **inside a block** — block-scoped function declarations (ES2015 §B.3.2) are lexically scoped and do conflict with `var`. But at **SourceFile scope**, function declarations are **var-scoped** (they hoist to the same scope as `var`) and the combination `var x; function x(){}` is always valid.

## Fix

In `checkVarLexicalConflicts` (`src/compiler/validation.ts:2601`), only add function declarations to `lexicalNames` when the scope is a Block, not a SourceFile:

```ts
} else if (ts.isFunctionDeclaration(stmt) && stmt.name) {
  // At SourceFile scope, function declarations are var-scoped — no conflict with var.
  // Only inside a block are function declarations lexically scoped (ES §B.3.2).
  if (ts.isBlock(block)) {
    lexicalNames.add(stmt.name.text);
  }
}
```

## Acceptance criteria

1. `var smoosh; function smoosh() {} export function test() { return typeof smoosh; }` compiles without error.
2. Inside a block: `{ let x = 1; var x = 2; }` still correctly errors.
3. Inside a block: `{ function x(){}; var x; }` still correctly errors.
4. Net improvement ≥ 50 tests.

## Estimated yield

~60 net (all are "valid script code" tests blocked by this false positive).

## Files

- `src/compiler/validation.ts:2601` — one-line fix

## Test Results

Probe `tests/issue-1389.test.ts` (6 cases) all pass:
- ✓ `var x; function x(){}` at SourceFile scope compiles (script-level: var-scoped)
- ✓ `function x(){}; var x;` at SourceFile scope (other order) also compiles
- ✓ `let x; var x;` at SourceFile scope STILL errors (let is genuinely lexical)
- ✓ `class X{}; var X;` at SourceFile scope STILL errors (class is lexical)
- ✓ `{ function x(){}; var x; }` inside a Block STILL errors (block-scoped function is lexical)
- ✓ `{ let x; var x; }` inside a Block STILL errors

Real test262 file `nested-function-script-code-valid.js` containing `var smoosh; function smoosh() {}` now compiles cleanly (previously: `Cannot redeclare block-scoped variable 'smoosh'`).

`tests/ts-wasm-equivalence.test.ts` and `tests/tdz-reference-error.test.ts` still pass (no regressions in scope-related tests).
