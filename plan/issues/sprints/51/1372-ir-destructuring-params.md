---
id: 1372
sprint: 51
title: "IR: support destructuring params (removes param-shape-rejected bypass)"
status: done
worktree: /workspace/.claude/worktrees/issue-1372-ir-destructuring-params
created: 2026-05-08
priority: high
feasibility: medium
reasoning_effort: high
task_type: feature
area: ir, codegen
language_feature: destructuring
goal: ir-full-coverage
---
# #1372 — IR: destructuring params

## Problem

The IR selector rejects any function with a destructuring param with reason
`"param-shape-rejected"` (`src/ir/select.ts:268`):

```typescript
if (!ts.isIdentifier(p.name)) return "param-shape-rejected";
```

This blocks:
```typescript
function process({ x, y }: Point): number { return x + y; }
function first([a, b]: number[]): number { return a; }
```

Both patterns are common in typed numeric code. The legacy path handles them via
`destructureParamArray` / object destructuring preamble before the function body.

## Root cause

The selector enforces `isIdentifier(param.name)` as a hard constraint. The from-ast lowerer
(`src/ir/from-ast.ts`) has no code path for binding-pattern params.

## Implementation plan

### Selector relaxation

In `src/ir/select.ts`, permit `ObjectBindingPattern` and `ArrayBindingPattern` param names
when all destructured properties are themselves IR-typed (number/boolean/class-ref). The type
check uses the *declared type annotation* of the param (e.g. `{ x, y }: Point`) not the
binding pattern shape.

New rule: a param with a binding-pattern name is accepted when it has an explicit TypeAnnotation
that resolves to an IR-eligible type (class ref, number, boolean). The binding pattern itself
is treated as syntactic sugar for a named param + local destructure preamble in from-ast.

Add fallback reason `"destructuring-param-complex"` for cases where the binding pattern is
too deep (nested destructuring, rest elements, computed keys) — these stay on legacy without
blocking simpler cases.

### from-ast lowerer extension

In `src/ir/from-ast.ts`, `lowerFunctionAstToIr`:

1. When a param has an `ObjectBindingPattern` name:
   - Emit the param as a single `IrParam` with a synthesized name `$param0` and the declared
     aggregate type.
   - Prepend `IrNode.letBind { name: field, value: IrNode.fieldGet { obj: $param0, field } }`
     for each destructured binding element.
   - The rest of the body sees the field names as regular locals.

2. When a param has an `ArrayBindingPattern` name:
   - Emit as `IrParam $param0: (vec of element type)`.
   - Prepend `IrNode.letBind { name: elem, value: IrNode.arrayGet { arr: $param0, index: i } }`
     for each bound element.

This mirrors what the legacy `destructureParamArray` does but in IR form, avoiding any legacy
fallback for the destructure preamble itself.

### Type resolution

`src/ir/propagate.ts` / `src/ir/types.ts` — ensure the TypeAnnotation on the param (e.g.
`Point`) resolves to an `IrType.class { name: "Point" }` via the class registry, which the
from-ast resolver can then field-access.

## Acceptance criteria

1. `function dot({ x, y }: Vec2, { x: bx, y: by }: Vec2): number { return x*bx + y*by; }` is
   IR-claimed and emits struct.get ops, not legacy extern dispatch.
2. `function head([first]: number[]): number { return first; }` is IR-claimed.
3. Complex nested patterns (`{ a: { b: c } }`) correctly fall through with
   `"destructuring-param-complex"`, not `"param-shape-rejected"` (better telemetry).
4. No regression in existing destructuring equivalence tests.

## Files

- `src/ir/select.ts` — relax binding-pattern param check
- `src/ir/from-ast.ts` — destructure-param preamble emission
- `src/ir/types.ts` or `src/ir/propagate.ts` — aggregate type resolution for params

## Resolution

### Implementation

**`src/ir/select.ts`** — added a binding-pattern arm to the param loop in
`whyNotIrClaimable`. When `p.name` is `ObjectBindingPattern` /
`ArrayBindingPattern`, the selector reuses the existing `isPhase1BindingPattern`
shape gate (identifier-leaf, no rest, no defaults, no nesting) and
`collectPatternNames` to thread leaves into scope. The new
`"destructuring-param-complex"` reason replaces `"param-shape-rejected"` for
patterns wider than slice 8a — kept distinct so the param-shape bucket
continues to count only optional/rest/initializer/duplicate cases.

**`src/ir/from-ast.ts`** — `lowerFunctionAstToIr` now synthesizes a
`__pattern_param_<idx>` SSA param for each binding-pattern AST param,
collects `(pattern, value)` pairs, and after `cx` is built emits the
destructure preamble via the existing `lowerBindingPattern` /
`lowerObjectPattern` / `lowerArrayPattern` helpers — same pipeline that
already handled `const { x, y } = obj` for var-decls, just on a param
SSA value rather than an initializer SSA value.

**`src/ir/from-ast.ts`** — extended `lowerObjectPattern` to accept
`IrType.class` sources (in addition to `IrType.object`), emitting
`emitClassGet` per leaf instead of `emitObjectGet`. Class shapes from
`buildIrClassShapes` already strip the `__tag` prefix and expose user
fields by name, so the leaf lookup is identical.

**`scripts/check-ir-fallbacks.ts`** — registered
`destructuring-param-complex` in the `UNINTENDED` set so a follow-up slice
that retires wider patterns is gated on a baseline drop. Current baseline
is unchanged — the playground/examples corpus has no functions with
complex param patterns.

### Test Results

`tests/issue-1372-ir-destructuring-params.test.ts` — 10 cases, all pass:

- AC#1 — `dot({ x, y }: Vec2, { x: bx, y: by }: Vec2)` is IR-claimed; the
  emitted `$dot` body contains `struct.get` ops (verified via WAT
  inspection), not the legacy uninitialised-locals dispatch. Runtime
  result: `dot((2,3), (4,5)) = 23` ✓.
- AC#2 — `head([first, second]: number[])` is IR-claimed in isolation
  (when called from a Phase-1-incompatible caller it drops via
  call-graph-closure, which is unrelated). Runtime result `30` ✓.
- AC#3a–d — nested object pattern, default value, rest pattern, nested
  array pattern all fall back as `"destructuring-param-complex"`
  (NOT `"param-shape-rejected"`).
- Identifier-only params still claim with no fallback reason.
- Optional `b?: number` still produces `"param-shape-rejected"` (kept
  distinct from the new bucket).
- Renaming `{ a: x, b: y }` works; runtime result `4` ✓.
- Inline object-type param `{ x, y }: { x: number; y: number }` claims
  and runs (`process({x:3, y:4}) = 10`) ✓.

`pnpm run check:ir-fallbacks` — green, no baseline change.
`npm test -- tests/ir/` — 39/39 pass (no IR-pipeline regressions).
