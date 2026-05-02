---
id: 1185
title: "IR Phase 4 — refactor: thread `IrLowerResolver` through `LowerCtx` (retire per-feature shortcuts)"
status: done
created: 2026-04-27
updated: 2026-04-27
completed: 2026-04-27
priority: medium
feasibility: medium
reasoning_effort: high
task_type: refactor
area: codegen
language_feature: compiler-internals
goal: maintainability
required_by: [1205]
es_edition: n/a
related: [1169e, 1181, 1182, 1183]
origin: surfaced as architectural-debt during #1182 / #1183 implementation; the current `LowerCtx` accumulates one-off threading hooks for every IR slice that needs resolver-time information at AST→IR-build time.
---
# #1185 — Refactor: thread `IrLowerResolver` through `LowerCtx`

## Problem

Slices 6 part 2/3/4 (#1181 / #1182 / #1183) each needed information
at AST→IR-build time that conceptually belongs to the
`IrLowerResolver` (which only exists at Phase-3 lowering time). Each
slice solved the gap with a narrowly-scoped threading shortcut
through `AstToIrOptions` → `LowerCtx`:

| Slice | Shortcut |
|-------|----------|
| #1181 (vec for-of) | hardcoded `inferVecElementValTypeFromContext` returning `f64`; relies on lowerer's `resolveVec` for actual validation |
| #1182 (iter-host) | `resolvePositionType` extended to return `externref` for builtin iterables |
| #1183 (string for-of) | `nativeStrings: boolean` + `anyStrTypeIdx: number` threaded through `AstToIrOptions` |

Each shortcut works in isolation, but the pattern doesn't scale.
Future slices (slice 7 — `for await`, slice E — try/catch, slice 8 —
destructuring) each introduce more "I need resolver-side info from
from-ast" needs. We should land a single resolver thread-through and
retire the shortcuts.

## Goal

Refactor `LowerCtx` (in `src/ir/from-ast.ts`) so it carries a
`IrLowerResolver` reference instead of per-feature flags + indices.
Update all from-ast call sites to use `cx.resolver.*` instead of
the threaded shortcuts.

## What this issue needs to land

### 1. Move `IrLowerResolver` interface to a shared location

Currently the interface is declared in `src/ir/lower.ts`. Move it to
`src/ir/types.ts` (or a new `src/ir/resolver.ts`) so `from-ast.ts`
can import it without pulling on `lower.ts`'s big dependency surface.

### 2. Add `resolver: IrLowerResolver` to `LowerCtx` + `AstToIrOptions`

`compileIrPathFunctions` (in `src/ir/integration.ts`) builds the
resolver once per compilation and passes it into every
`lowerFunctionAstToIr` call.

### 3. Retire the per-feature shortcuts

Remove from `AstToIrOptions` / `LowerCtx`:
  - `nativeStrings` → `cx.resolver.nativeStrings?.()`
  - `anyStrTypeIdx` → derive from `cx.resolver.resolveString()` (which
    returns `(ref $AnyString)` in native mode)

Add to `IrLowerResolver`:
  - `nativeStrings(): boolean` — returns `ctx.nativeStrings`
  - Already has: `resolveString()`, `resolveVec()`, `resolveObject()`,
    `resolveClosure()`, `resolveClass()`, etc.

Update `lowerForOfString` to call `cx.resolver.resolveString()`
directly to get the slot ValType.

Update `inferVecElementValTypeFromContext` (slice 6 part 2 hack) to
call `cx.resolver.resolveVec(valTy)?.elementValType` — resolves the
`f64`-only hardcoding.

### 4. Slot-binding "as IrType" widening (deferred from #1183)

While the refactor is open: extend `ScopeBinding.kind === "slot"`
with an optional `asType?: IrType` so identifier reads can re-tag
the slot.read SSA result to a different IrType.

Concrete use case: in #1183's native-strings string for-of, the loop
variable's slot ValType is `(ref $AnyString)` but we want body code
to see it as `IrType.string` so string ops compose. Today the slot
binding's `type` is `irVal((ref $AnyString))`, which means
`cx.builder.emitSlotRead` returns `irVal((ref $AnyString))` — and
slice-1 string ops (`+`, `===`, `.length`) reject that type. With
`asType: { kind: "string" }` the identifier handler in `lowerExpr`
could insert a no-op tag rewrite (in native mode the underlying
ValType is identical) so the SSA value carries `IrType.string`.

Pure type-system change at the IR level — no Wasm emission impact.

### 4b. (Bonus, opportunistic) consolidate `forof.*` family

The IR now has three statement-level for-of declarative variants:

  - `IrInstrForOfVec` (#1181) — vec fast path
  - `IrInstrForOfIter` (#1182) — host iterator protocol
  - `IrInstrForOfString` (#1183) — native-strings counter loop

All three share a common shape:
  - statement-level (`result: null`)
  - one or more pre-allocated slot indices for cross-iteration state
  - a `body: readonly IrInstr[]` buffer

Every traversal helper has parallel switch arms across the three:
  - `src/ir/lower.ts` — `registerInstrDefs`, use-recording (line ~378),
    `allocLocalForInstr`, `collectIrUses`, `collectForOfBodyUses`
  - `src/ir/verify.ts` — `collectUses`
  - `src/ir/passes/dead-code.ts` — `isSideEffecting`, `collectInstrUses`
    (the body-walk closure has 3 explicit kind checks)
  - `src/ir/passes/inline-small.ts` — operand renaming
  - `src/ir/passes/monomorphize.ts` — `collectUses` body-walk

Refactor candidate: factor a `IrForOfBase` interface (or use a single
discriminated `forof` instr with a strategy-tag field) so the
traversal helpers walk a uniform `body` buffer without per-variant
switch arms. Estimate: ~150 LOC reduction across the IR layer.

Slice 7 (`forof.async-iter`) and slice 8 (destructuring variants of
each) would otherwise add more parallel arms — so consolidating now
pays compound interest.

This is **opportunistic**: only do it if #1185's primary refactor
naturally surfaces it. If it would balloon the PR, file as a follow-up.

### 5. Test refactor

The existing `tests/issue-1181.test.ts` / `1182.test.ts` /
`1183.test.ts` should continue to pass without modification. Add a
new test in `tests/issue-1183.test.ts` (or a new file) that
exercises body-side string ops on the loop variable in native mode
— this validates the slot-binding widening:

```ts
function fn(): string {
  const s = "abc";
  let result = "";
  for (const c of s) {
    result = result + c;  // string concat with the loop var
  }
  return result;
}
```

Today this throws `ir/from-ast: ...` and falls back to legacy. After
the refactor it should claim through the IR.

## Out of scope

- Threading the resolver into the IR PASSES (constant-fold,
  dead-code, inline-small, monomorphize). Passes don't currently
  need resolver info; keep them resolver-free for now.
- Changing the resolver's existing methods. Just adding
  `nativeStrings(): boolean`.

## Acceptance criteria

1. `LowerCtx` no longer carries `nativeStrings` / `anyStrTypeIdx`
   fields; both are reachable via `cx.resolver`.
2. `inferVecElementValTypeFromContext` is removed (replaced by
   `cx.resolver.resolveVec(valTy)?.elementValType`).
3. `inferVecDataValTypeFromContext` similarly removed (replaced by
   `cx.resolver.resolveVec(valTy)?.dataFieldValType`, adding the
   missing field to `IrVecLowering` if absent).
4. The slice-6 part 2 hardcoded-`f64` element type is gone — vec
   for-of works for any element ValType the resolver recognises
   (validated by a new equivalence test with `string[]` if feasible).
5. Slot bindings carry an optional `asType` widening; native-mode
   string for-of body can compose with slice-1 string ops.
6. All existing IR tests pass unchanged.
7. CI test262 net delta ≥ 0.

## Implementation plan (rough)

  1. Move `IrLowerResolver` interface to a new `src/ir/resolver-types.ts`.
  2. Add `nativeStrings()` to the resolver interface; implement in
     `makeResolver` (integration.ts) returning `ctx.nativeStrings`.
  3. Extend `IrVecLowering` with `dataFieldValType: ValType` if missing
     (read from the struct definition in `resolveVec`).
  4. Add `resolver: IrLowerResolver` to `AstToIrOptions` + `LowerCtx`.
     Threading: `compileIrPathFunctions` already constructs the
     resolver before lowering; pass it into the per-function
     `lowerFunctionAstToIr` call.
  5. Update `lowerForOfStatement` arms:
     - vec → call `cx.resolver.resolveVec(valTy)`; on `null` throw
       (current "always-vec" assumption goes away)
     - string → use `cx.resolver.resolveString()` for slot ValType
  6. Drop `nativeStrings` / `anyStrTypeIdx` from AstToIrOptions /
     LowerCtx; remove the `inferVec*FromContext` helpers.
  7. Slot binding widening: add `asType?: IrType` to the `slot`
     ScopeBinding; in `lowerExpr` identifier handling, when present,
     emit a `coerce.no_op` (or just use the irType directly without
     re-fetching from slot.type).
  8. Run prior IR tests + add the new string-concat-in-body test.

## Sub-issue of

\#1169 — IR Phase 4: full compiler migration
