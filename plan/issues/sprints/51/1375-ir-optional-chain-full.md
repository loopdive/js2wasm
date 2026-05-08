---
id: 1375
sprint: 51
title: "IR: full optional-chain support (?. and ?.[]) without resolver fallback"
status: blocked
created: 2026-05-08
priority: medium
feasibility: hard
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

## Architectural finding (dev-1389, 2026-05-08)

The original spec references IR primitives that **do not exist** in the
current codebase. Verified on origin/main HEAD `5076ca504`:

- `IrLowerResolver.nullCheck` field — does not exist anywhere in `src/`
  (`grep -rn "nullCheck\b" src/` returns 0 results). The original spec
  text "extend `makeIrLowerResolver` to handle the case where the
  receiver is `externref`" describes a method that was never wired up.
- `IrNode.if` / `IrNode.ifNull` / value-producing if-expr — does not
  exist. The IR has only `IrInstrSelect` (`kind: "select"`), which
  lowers to **Wasm `select`** — eager-eval of both arms. That's
  unsuitable for `?.` semantics, since the non-null arm (`obj.prop`)
  traps when `obj` is null.
- `ref.is_null` — present in `src/ir/types.ts:229` (the **legacy**
  codegen Wasm op enum), but **NOT** present in the IR's `IrUnop` type
  (`src/ir/nodes.ts:503` — only `f64.neg`, `i32.eqz`,
  `i32.trunc_sat_f64_s`, `f64.abs`, `f64.sqrt`, `f64.floor`,
  `f64.ceil`, `f64.trunc`).

`from-ast.ts:1452` confirms the gap explicitly: "the IR has no
short-circuit primitive yet — throw so the function falls back to
legacy". The legacy `compileOptionalPropertyAccess`
(`src/codegen/property-access.ts:739`) uses Wasm `if`/`else` block —
the structured value-producing control flow the IR doesn't have for
expressions.

**To fully implement** this issue's Acceptance Criteria (1–3), the IR
must gain:

1. A new `ref.is_null` `IrUnop` (one-line addition to `IrUnop` type +
   wiring in `lower.ts` to emit the Wasm op).
2. A value-producing `IrInstrIfExpr` with `cond`, `then` body, `else`
   body, and `result` — analogous to the existing statement-level
   `IrInstrWhileLoop` / `IrInstrTry` patterns but with a result.
3. Lowering through `lower.ts` (Wasm `if` block with result type),
   `verify.ts` (verify result types match across arms), `propagate.ts`
   (propagate types into both arms), and `constant-fold.ts` (fold when
   cond is constant).
4. Block-restructuring or new emit helpers in `lowerPropertyAccess`,
   `lowerElementAccess`, and `lowerCall` to use the new branching for
   `?.`, `?.[]`, and `?.()`.

Each is tractable in isolation but the combined surface is genuinely
`feasibility: hard`. Re-ranked from `medium` accordingly. Status set to
`blocked` until an architect spec for the new IR primitives lands.

## Implementation notes (Slice A: TS-narrowing fast-path, dev-1389, 2026-05-08)

### Slice A scope

**~25 LoC** — extends `lowerPropertyAccess` to consult TypeScript
narrowing before throwing the legacy-fallback for `?.` on an
IR-nullable receiver. When TS proves the expression's type is
non-null (`getNonNullableType(t) === t` by identity), skip the throw
and fall through to ordinary `.` access — this mirrors how the
existing slice 11 (#1281) handles non-null IR types.

### Why this is a real win (despite being narrow)

The IR's `isIrTypeNullable` is conservative: it flags **all** `extern`
host-class values as nullable because at the Wasm level they're
`externref`. But `m: Map<string, number>` (no `| undefined`) is
TS-proven non-null in well-typed code. This slice recognizes that
case and keeps the function on the IR path instead of falling back to
legacy.

### Files changed

- `src/ir/from-ast.ts`:
  - `IrFromAstResolver` interface — added optional method
    `isExpressionTsNonNullable(expr: ts.Expression): boolean | undefined`.
  - `lowerPropertyAccess` — when the existing `?.` throw guard fires,
    consult the resolver method first; skip the throw on TS-proven
    non-null.
- `src/ir/integration.ts`:
  - `makeFromAstResolver` — implementation using
    `ctx.checker.getNonNullableType()` with strict identity comparison
    (TS interns Type objects; identical identity ⇒ stripping null was
    a no-op ⇒ already non-null).

### Tests

`tests/issue-1375.test.ts` — 6 tests:
- Map (non-null TS type): `m?.get(k)` — exercises the new fast-path
- Map | undefined (genuinely nullable): still works via legacy fallback
- object literal `o?.x` — existing non-null IR path (regression guard)
- class instance `c?.field` — existing non-null IR path (regression guard)
- nullable receiver actually undefined at runtime — legacy returns undefined
- RegExp `r?.source` — extern with non-null TS type via fast-path

All pass. `tests/issue-1281.test.ts` (predecessor for non-null TS narrowing)
also passes — no regression.

### Estimated impact (Slice A)

Narrow — 5–10 hot functions retire from legacy fallback, mostly Map/Set
property access patterns where TS guarantees non-null. The full
acceptance criteria (1–3) require the IR primitive work outlined in
"Architectural finding" above.
