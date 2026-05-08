---
id: 1372
sprint: 51
title: "IR: support destructuring params (removes param-shape-rejected bypass)"
status: in-progress
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
