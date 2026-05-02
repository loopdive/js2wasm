---
id: 1163
title: "Static eval inlining — compile eval(\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\"fixed string\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\") at compile time (~208 tests)"
status: done
created: 2026-04-22
updated: 2026-04-28
completed: 2026-04-28
priority: high
feasibility: medium
reasoning_effort: medium
task_type: feature
area: codegen
language_feature: eval
goal: spec-completeness
required_by: [1164]
closed: 2026-04-23
pr: 8
net_improvement: 491
---
# #1163 — Static eval inlining: compile `eval("fixed string")` at compile time

## Problem

208 test262 tests use `eval` with a string literal argument and are currently
failing. These do not require a runtime eval implementation — the string is
a compile-time constant and can be parsed and inlined at compile time.

Example patterns:
```js
eval("var x = 1; x + 2");
eval("(function() { return 42; })()");
eval("throw new TypeError('msg')");
```

## Strategy

At each `eval(...)` call site, check if the argument is a string literal
(or string literal concatenation that resolves to a constant). If so:

1. Parse the string as a Script/Module using the TypeScript parser
2. Lower the resulting AST inline at the call site, as if the code appeared
   directly in the enclosing scope
3. Thread the return value back through normal expression lowering

For the indirect case (`(0, eval)(src)`) with a string literal, treat it as
global-scope inlining (no caller-scope variable access).

## Scope

- `eval("string literal")` — direct and indirect, expression and statement forms
- String literal concatenation: `eval("var x = " + "1")` only if both sides
  are literals (resolve at compile time)
- Throw propagation: if the inlined code throws, the throw propagates normally
- Return value: last expression value returned to the call site

## Out of scope

- Dynamic eval (non-constant argument) — see #1164
- Scope capture for direct eval beyond what the current codegen model supports
- `new Function(...)` with constant strings — follow-up

## Acceptance criteria

- `eval("1 + 2")` compiles and returns `3`
- `eval("var x = 42; x")` introduces `x` and returns `42`
- `eval("throw new TypeError('msg')")` propagates the TypeError correctly
- 208 → significant reduction in literal-eval test failures
- No regressions in `tests/equivalence.test.ts`

## ECMAScript spec reference

- [§19.2.1 eval(x)](https://tc39.es/ecma262/#sec-eval-x) — step 2: if x is not a String, return x
- [§19.2.1.1 PerformEval](https://tc39.es/ecma262/#sec-performeval) — steps 3–10: parse Script, create eval context, evaluate

## Implementation Notes

Landed in `src/codegen/expressions/eval-inline.ts` and wired into the
`isEvalCallExpression` branch of `compileCallExpression` (`src/codegen/expressions/calls.ts`).

Flow:

1. `resolveConstantString` walks the first argument and folds
   string-literal / no-substitution-template-literal / `"a" + "b"` chains
   into a single JS source string. Anything else → fall through.
2. `ts.createSourceFile("<eval>.ts", src, Latest, setParentNodes=true, JS)`
   parses the source. If `sf.parseDiagnostics` is non-empty we bail out so
   the host eval can signal the SyntaxError correctly.
3. An AST pre-scan (`allNodesInlineSupported`) rejects node kinds that need
   type-checker bindings we can't provide for foreign nodes — function /
   arrow / class declarations and expressions, for-of / for-in,
   yield / await, import/export. These fall through to `__extern_eval`.
4. `hoistVarDeclarations` / `hoistLetConstWithTdz` /
   `hoistFunctionDeclarations` run over the parsed statement list just
   like in a normal function body.
5. All but the last statement go through `compileStatement`. If the last
   statement is an `ExpressionStatement`, its expression becomes the
   call result (coerced to `externref`). Otherwise we emit it and push
   `undefined`.
6. Additional `eval(...)` arguments are still evaluated for side effects
   and dropped.

The existing `__extern_eval` host path (#1006) is unchanged and serves as
the fallback for every case the static inliner rejects. In standalone /
WASI builds the host import is absent, so a fallthrough will still trap;
that matches the pre-existing behavior.

## Test Results

- New tests: `tests/issue-1163.test.ts` — 8 / 8 pass (arithmetic, string
  concat, `var` + identifier, `throw new TypeError(...)`, compile-time
  `+` concat, template literal, indirect `(0, eval)(...)`, zero-arg
  fallback).
- Existing `tests/issue-1006.test.ts` (dynamic eval host) — 7 / 7 pass,
  confirming the fallback path still works for non-literal arguments,
  malformed sources, and IIFEs.
- Full `tests/equivalence/*.test.ts` suite: 1185 / 1291 pass, identical
  to pre-change baseline on the same worktree (106 failures are
  pre-existing on main @ 3954b7821 — verified by re-running with the
  change stashed). No new equivalence regressions.
