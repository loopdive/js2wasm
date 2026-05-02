---
id: 1167b
title: "IR Phase 3b — inline-small: inline direct IR calls before lowering"
status: done
created: 2026-04-22
updated: 2026-04-28
completed: 2026-04-28
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: feature
area: codegen
language_feature: compiler-internals
goal: compiler-architecture
depends_on: [1167a]
required_by: [1167c]
closed: 2026-04-23
pr: 9
net_improvement: 0
---
# #1167b — IR Phase 3b: inline-small (direct IR-to-IR calls only)

## Context

Second slice of IR Phase 3. Inline small function bodies at the IR level
before lowering. This is strictly IR-to-IR: both caller and callee must be
IR-path functions (guaranteed by `planIrCompilation` / `select.ts` — the
call-graph closure in `select.ts:92-118` only claims functions whose callee
chain is also claimed).

This **adds** IR-level inlining. `InlinableFunctionInfo` (`src/codegen/context/types.ts:70-89`)
is a parallel mechanism operating on already-emitted backend `Instr[]` — it is
fundamentally orthogonal. Both coexist: IR-level inlining covers IR-path
functions; the legacy mechanism continues for legacy-path functions indefinitely.
Do not remove `InlinableFunctionInfo`.

## Scope — single-block callees only (v1)

Only inline callees whose `blocks.length === 1` ending in a single `return`.
This covers ternary-style helpers (`abs`, `clamp`, `min`, `max`, `isNaN`).
Multi-block inlining (multiple `return` terminators requiring continuation
blocks + `br` splicing) is deferred to a follow-up.

## IrModule container

`inlineSmall` requires visibility across all IR functions simultaneously.
Introduce in `src/ir/nodes.ts`:

```ts
export interface IrModule {
  readonly functions: readonly IrFunction[];
}
```

`compileIrPathFunctions` in `src/ir/integration.ts:48-123` currently
interleaves build + lower per function. This pass requires splitting it into
two phases:
1. Build all `IrFunction[]` (accumulate)
2. Run CF + DCE + simplifyCFG + inlineSmall + re-run CF + DCE
3. Lower all to Wasm

This is a structural refactor of `integration.ts` — not just wiring after
simplifyCFG.

## Algorithm

1. For each `IrInstrCall` in an IR function body:
   - Look up callee in `IrModule.functions`
   - Skip if callee `blocks.length > 1` (multi-block — deferred)
   - Skip if callee is recursive (call graph cycle)
   - Skip if callee instruction count > N (start with N = 10)
   - Otherwise: inline
2. Inlining a single-block callee:
   - `IrFunction.blocks` is `readonly` — produce a new `IrFunction`, do not
     mutate in place
   - Allocate fresh `IrValueId`s for every callee-defined value:

```ts
function inlineSingleBlockCallee(
  caller: IrFunction,
  callSite: IrInstrCall,
  callee: IrFunction,
): IrFunction {
  assert(callee.blocks.length === 1);
  const [body] = callee.blocks;
  assert(body.terminator.kind === "return" && body.terminator.values.length === 1);

  const rename = new Map<IrValueId, IrValueId>();
  for (let i = 0; i < callee.params.length; i++) {
    rename.set(callee.params[i].value, callSite.args[i]);
  }
  for (const inst of body.instrs) {
    if (inst.result !== null) {
      rename.set(inst.result, caller.builder.freshValueId());
    }
  }
  // Rewrite callee instrs with remapped operands; splice into caller block
  // at callSite position; callSite.result ← renamed return value
}
```

3. After inlining, re-run `constantFold` + `deadCode` + `simplifyCFG` on the
   modified function
4. Guard: total instruction count must not exceed 4× original caller size

## What this enables

For the canonical fib benchmark after #1166 integer specialization:

```
fib calls fib(n-1) and fib(n-2) — recursive, not inlined
run calls fib(n)  — if run body ≤ 10 instructions, fib call is NOT inlined
                    (fib is recursive → inlining guard fires)
```

More useful for small utility functions: `clamp(x, lo, hi)`,
`abs(x)`, `isNaN(x)` — these are non-recursive and typically ≤ 5 instructions.

## Pipeline position

```
constantFold → deadCode → simplifyCFG  (Phase 3a)
  → inlineSmall                         ← this issue
  → constantFold (re-run on inlined fns)
  → deadCode (re-run)
  → lowerToWasm
```

## Key files

- `src/ir/passes/inline-small.ts` — new file
- `src/ir/nodes.ts` — add `IrModule` interface
- `src/ir/integration.ts` — split `compileIrPathFunctions` into build + pass + lower phases

## Acceptance criteria

1. `IrModule` interface exists in `src/ir/nodes.ts`
2. `src/ir/passes/inline-small.ts` exists; exports `inlineSmall(mod: IrModule)`
3. `compileIrPathFunctions` in `integration.ts` split into build / pass / lower phases
4. Single-block, non-recursive callee with ≤ 10 instructions is inlined
5. Multi-block callees are skipped (not an error)
6. Recursive callees are skipped (not an error)
7. Fresh `IrValueId`s allocated for all callee-defined values; `verifyIrFunction`
   returns zero errors on the caller after inlining
8. After inlining, `constantFold` + `deadCode` re-run on modified functions
9. Unit test: `abs(x: number) { return x < 0 ? -x : x; }` single-block form
   gets inlined at its call site; emitted WAT contains no `call $abs`
10. `npm test -- tests/equivalence.test.ts` passes with no regressions
11. No regressions in test262

## Related

- #1167 — parent meta issue
- #1167a — constant-fold + dead-code + simplify-cfg (prerequisite)
- #1167c — monomorphize + tagged-unions (follow-on, blocked on frontend widening)

## Architect Review — Round 2

Four concrete gaps a dev will hit, plus two smaller ones:

### 1. `IrModule` does not exist

Acceptance criterion 1: `inlineSmall(mod: IrModule)`. The `IrModule` type is not defined anywhere — `grep -rn "IrModule" src/ir` returns nothing. The current IR is per-function: `lowerFunctionAstToIr(fn)` returns an `IrFunction`, and `compileIrPathFunctions` (`src/ir/integration.ts:48-123`) processes them one at a time in a loop. There is no module-level container.

For inlining to see callee bodies, this container must exist. Spec should either:
- **(a)** Introduce `export interface IrModule { readonly functions: readonly IrFunction[]; }` in `nodes.ts` and a builder that runs before inlining, or
- **(b)** Thread a `Map<string, IrFunction>` through the pass (the callee lookup referred to on line 41 as "`IrModule.functions`").

Either is fine but pick one. Recommended: (a) — it matches "module" vocabulary used elsewhere and makes the pipeline picture clean.

### 2. Pipeline restructuring is required, not just "wire after simplifyCFG"

Today's `compileIrPathFunctions` loop (`integration.ts:74-120`) does three things per function: `lowerFunctionAstToIr` → `verifyIrFunction` → `lowerIrFunctionToWasm`. There's no point between "I have all IR functions" and "I start lowering" — they're interleaved.

For inlining to work we need:
1. Build all IR functions first (accumulate `IrFunction[]`)
2. Run CF + DCE + simplify-cfg on each
3. Run `inlineSmall` across the module (needs to see all callees)
4. Re-run CF + DCE + simplify-cfg on every modified caller
5. Lower to Wasm

Spec says "Pipeline position" (line 65) as if wiring is a one-liner. It isn't — it's a structural refactor of `integration.ts`. Add to the issue body: "this pass requires splitting `compileIrPathFunctions` into a build phase and a lower phase".

### 3. Multi-block callees: spec doesn't pick a strategy

The algorithm (line 42-50) says "copy callee body into caller, substituting: Callee params → caller argument values (SSA rename); Callee return → value passed to the next instruction in caller". This works for a single-block callee whose entire body is `return <expr>`:

```ts
function abs(x: number): number { return x < 0 ? -x : x; } // 1 block, 1 select, 1 return
```

It does NOT work for a multi-block callee:

```ts
function abs(x: number): number {
  if (x < 0) return -x;
  return x;
}  // 3 blocks: entry(br_if) → thenBlock(return) | elseBlock(return)
```

Here the callee has two `return` terminators; inlining must turn each into "produce value v and branch to a continuation block in the caller". That requires a `br` terminator (blocked on 1167a adding `br` lowering) AND a continuation-block splice that changes the caller's CFG shape. Non-trivial.

The acceptance criterion mentions `abs(x)` without specifying which form. Dev will make the wrong call unless spec picks:
- **Option A (recommended for first slice):** only inline callees that are exactly 1 block ending in `return`. Covers ternary-style helpers (`abs` ternary, `clamp`, `min`, `max`, `isNaN`). Simple.
- **Option B (later):** full multi-block splicing. Needs `br` lowering + continuation blocks + block ID rebasing. Blocked on 1167a's `br` work.

Add a section "Scope — single-block callees only (Option A)" with explicit text: "multi-block inlining is deferred to a follow-up; callees whose `blocks.length > 1` are skipped".

### 4. "SSA rename" is hand-waved

Line 45 says "SSA rename". Specifically required:
- **Fresh IrValueIds** for every callee-defined value. Callee's value IDs (`nodes.ts:72-86`, branded number allocator) are function-scoped; reusing them in the caller violates the single-definition invariant in `verify.ts:94-104`.
- **Fresh IrBlockIds** for callee blocks (when Option B). Block IDs must stay contiguous (`verify.ts:42`).
- **Substitute callee param values** with the caller's argument values wherever they're used as operands in callee instrs and terminators.
- **Rewrite callee `return v`** into "set caller's call result to v; br to continuation" (Option B) or "the value of v becomes the call-expression result" (Option A).

Pseudocode for Option A:

```ts
function inlineSingleBlockCallee(
  caller: IrFunction,
  callSite: IrInstrCall,
  callee: IrFunction,
): void {
  assert(callee.blocks.length === 1);
  const [body] = callee.blocks;
  const terminator = body.terminator;
  assert(terminator.kind === "return" && terminator.values.length === 1);

  // Allocate fresh IDs for every callee-defined value
  const rename = new Map<IrValueId, IrValueId>();
  for (let i = 0; i < callee.params.length; i++) {
    rename.set(callee.params[i].value, callSite.args[i]);
  }
  for (const inst of body.instrs) {
    if (inst.result !== null) {
      rename.set(inst.result, caller.builder.freshValueId());
    }
  }

  // Rewrite callee instrs with remapped uses + splice into caller's block
  // (at the position where callSite lives; callSite is replaced).
  // The callee's return value (after remap) becomes callSite.result.
}
```

Spec should show this (or similar) so the dev doesn't recreate the design.

### 5. Minor — `IrFunction.blocks` is `readonly`

`nodes.ts:307` says `readonly blocks: readonly IrBlock[]`. Inlining mutates block content, which means either casting away readonly or building a new `IrFunction`. The IR-scaffold comment (`nodes.ts:16`) says the union is open for widening — and `valueCount` is already tracked for "re-entering the builder" — so this is recoverable. But the spec should say "inlineSmall produces new `IrFunction` values; it does not mutate in place". Otherwise dev will introduce `as unknown as IrBlock[]` casts.

### 6. Minor — "replaces InlinableFunctionInfo" framing

Line 27-36 says this "replaces" the legacy mechanism. The framing is accurate now (line 34-36 clarifies the two coexist) but strengthen the point: `InlinableFunctionInfo` operates on already-emitted backend `Instr[]` — it is fundamentally orthogonal to IR-to-IR inlining. They are parallel mechanisms that happen to share a name. Recommend rewording "replaces" → "adds IR-level inlining. The legacy mechanism continues to cover legacy-path functions indefinitely."

### Summary

1167b is scoped correctly at a high level (IR-to-IR, direct calls, small, non-recursive) but underspecifies (a) the `IrModule` container that the signature requires, (b) the pipeline restructuring in `integration.ts`, (c) single-block vs multi-block callee strategy, and (d) the SSA rename / fresh-ID mechanics. All four should be in the spec before dispatch.
