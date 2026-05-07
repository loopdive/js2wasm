---
id: 1375
sprint: 51
title: "IR: full optional-chain support (?. and ?.[]) without resolver fallback"
status: ready
created: 2026-05-08
priority: medium
feasibility: medium
reasoning_effort: high
task_type: feature
area: ir, codegen
language_feature: optional-chain
goal: ir-full-coverage
---
# #1375 — IR: full optional-chain support

## Problem

Optional chains (`?.`) fall back to legacy when the `IrLowerResolver` is absent or returns
`null` for the nullability check:

```typescript
// src/ir/from-ast.ts:167
/** Optional-chain nullability check (#1281). When absent, `?.` / `?.()` throw to legacy. */
nullCheck?: (val: IrNode) => IrNode;
```

And:
```typescript
// src/ir/from-ast.ts:653
/** Optional-chain nullability check (#1281). When absent, `?.` / `?.()` throw to legacy. */
```

The `nullCheck` resolver method IS wired in `integration.ts`, but only for the Phase 1
case where the value's type is known. For `externref`-typed receivers, the wiring may be
absent or incomplete, causing the function to fall back.

Additionally, `?.[]` (optional element access) may not be handled by the IR selector's
`isPhase1Expr` check for `ElementAccessExpression` with the optional-chain flag.

## Root cause

Two gaps:
1. `isPhase1Expr` in `select.ts` may not handle `OptionalPropertyAccessExpression` with
   chained `?.()` (method call on optional result) — check `ts.isCallExpression` where
   callee has `questionDotToken`.
2. `IrLowerResolver.nullCheck` in `integration.ts` — if the receiver ValType is `externref`
   (not a struct ref), the integration's `nullCheck` implementation doesn't know how to
   emit a null test for externref.

## Implementation plan

### Fix 1 — selector completeness

In `src/ir/select.ts` `isPhase1Expr`, add explicit handling for:
- `ts.isOptionalChain(expr)` flag — `PropertyAccessExpression` with `questionDotToken`
- Chained optional calls: `a?.b?.()` — both links must individually satisfy `isPhase1Expr`

### Fix 2 — resolver externref null check

In `src/ir/integration.ts`, extend `makeIrLowerResolver` to handle the case where the receiver
is `externref`:
```typescript
nullCheck: (val) => {
  if (resolvedType is externref) {
    // emit: (local.get $v) (ref.is_null) — externref null check
    return IrNode.refIsNull(val);
  }
  // existing struct-ref null check
  return IrNode.refIsNull(val);
}
```

Both cases emit `ref.is_null` in WasmGC. The distinction matters for the lowerer's ValType
emission; unify to always emit `ref.is_null` for any nullable ref type.

### Fix 3 — `?.[]` element access

In `src/ir/from-ast.ts`, the optional element access (`a?.[key]`) should lower to:
```
if (a is null) { result = null } else { result = a[key] }
```
Using `IrNode.ifNull` (already exists as `IrNode.if` + null check) + `IrNode.elemGet`.
Ensure `isPhase1Expr` in select.ts accepts `ElementAccessExpression` with optional-chain flag.

## Acceptance criteria

1. `function getName(obj?: { name: string }): string { return obj?.name ?? ""; }` is
   IR-claimed and emits `ref.is_null` + conditional, not a legacy call.
2. `a?.b?.c` (chained optional access) is handled.
3. `arr?.[0]` (optional element access) is handled.
4. No regression in optional-chain equivalence tests.

## Files

- `src/ir/select.ts` — optional-chain `isPhase1Expr` completeness
- `src/ir/from-ast.ts` — `?.[]` lowering
- `src/ir/integration.ts` — `nullCheck` externref case
