---
id: 1281
title: "IR: optional chaining `?.` and `?.()` — IR path support"
status: ready
created: 2026-05-02
updated: 2026-05-02
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: feature
area: codegen, ir
language_feature: optional-chaining
goal: npm-library-support
related: [1169, 1244, 1274]
---
# #1281 — IR: optional chaining `?.` and `?.()` in IR path

## Problem

Optional chaining (`obj?.prop`, `obj?.method()`, `arr?.[i]`) is implemented in the legacy
codegen (`src/codegen/property-access.ts:842` checks `questionDotToken`) but is NOT
handled in the IR from-ast layer. Any IR-path function that uses `?.` falls back to
legacy or produces a compile error.

Hono and ESLint use optional chaining throughout middleware and config access:
```ts
const handler = ctx.handlers?.[method];
const value = config?.rules?.['no-unused-vars'];
obj?.dispose();
```

## Root cause

`src/ir/from-ast.ts` does not handle `PropertyAccessExpression` with
`questionDotToken`. The IR has no dedicated "optional" instr variant.

## Approach

Optional chaining is syntactic sugar over a null check + property access. In the IR,
`a?.b` compiles to:

```
t0 = <emit a>
t1 = ref.is_null(t0)             ;; or tag.test for null IrType
br_if t1 → null_block           ;; if null/undefined, produce null
t2 = object.get t0 "b"          ;; else access field
return t2
```

Since the IR has `br_if` terminators and block args, optional chaining maps cleanly to
a two-block pattern: the "null" arm and the "non-null" arm, joined at a merge block via
block args.

For `?.()` (optional call): check callee is non-null, then `closure.call` / `class.call`.

## Scope

1. `obj?.prop` — optional property access
2. `obj?.method(args)` — optional method call
3. `arr?.[i]` — optional computed access (if receiver is a known vec/map)
4. `fn?.()` — optional function call

Chained `a?.b?.c` = nested optional chains — each level adds one null-check + branch.

## Acceptance criteria

1. `const x = obj?.prop` — null if obj is null/undefined, value otherwise
2. `obj?.method(42)` — no-op if obj is null/undefined, calls method otherwise
3. `tests/issue-1281.test.ts` covers property, method, and chained forms
4. No regression in property-access tests
