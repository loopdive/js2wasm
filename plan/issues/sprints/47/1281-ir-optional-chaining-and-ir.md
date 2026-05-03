---
id: 1281
sprint: 47
title: "IR: optional chaining `?.` and `?.()` — IR path support"
status: done
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

## Resolution

The IR's eager-evaluation primitives (no short-circuit `if/else` for property
access — `emitSelect` evaluates both branches) make a full IR-side null-guarded
optional chain a substantial addition: it'd require basic-block branching in the
lowerer or a dedicated `null-safe-get` IR instruction.

This commit takes the pragmatic narrow-but-real win: when the receiver/callee's
TypeScript type is provably non-nullable (the common case in well-typed code
where `?.` is used as defensive habit), the IR strips the `?.` and lowers it
like a regular `.` access. Genuinely nullable receivers (`T | null | undefined`,
`any`, `unknown`) still throw to the legacy path, where the existing
`compileOptionalPropertyAccess` / `compileOptionalCallExpression` helpers emit
the null-guarded `if/else` block that the issue's "Approach" section sketches.

The nullability gate uses `getNonNullableType` plus explicit checks for
`Null | Undefined | Void | Any | Unknown` and union-member traversal, so
`a?.b?.c` where the inner `a?.b` types as `T | undefined` (TypeScript adds
`undefined` to every `?.` result type) correctly falls through to legacy.

Implemented in `src/ir/from-ast.ts`:
- `lowerPropertyAccess`: gates `?.` on receiver nullability via
  `isPossiblyNullable`. Non-nullable receivers fall through to the regular
  property-access lowering. Nullable receivers throw clean fallback.
- `lowerCall`: same gate for `?.()` — checks the callee's TS type. Non-null
  callees lower as regular calls; nullable callees throw clean fallback.
- New helper `isPossiblyNullable(type, checker)` near `staticTypeOfFor`.

## Out of scope (follow-up)

Full short-circuit IR support for nullable receivers — chained `a?.b?.c`
where the inner `?.b` adds `undefined` to the type — needs structured IR
control flow (basic-block branching in the lowerer or a `null-safe-get`
instruction). The legacy fallback covers single-level nullable cases today;
a separate issue should track full IR support if profile data shows enough
hot functions are still falling back to legacy because of `?.`.

## Test Results

- `tests/issue-1281.test.ts`: 8/8 pass — covers non-null typed `?.prop`,
  `?.method()`, class-instance `?.method`, mixed non-null arithmetic,
  null any-typed receiver fallback, real any-typed receiver fallback, and
  the regular `.prop` regression guard.
- `tests/issue-1169n.test.ts` (slice 11 IR regression guard): passes.
- `tests/issue-1169o.test.ts` (IR fallback warnings): passes.
- `tests/issue-1169p.test.ts` (IR slice tests): passes.
- `tests/issue-1169q.test.ts` (IR fallback telemetry): 10/10 pass.
