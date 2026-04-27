# Senior Dev — #1169e (IR Slice 6: iterators + for-of)

**Started**: 2026-04-27
**Status**: in progress
**Worktree**: `/tmp/worktrees/wt-1169e`
**Branch**: `issue-1169e`

## Scope analysis (read this before reviewing the PR)

After reading the spec (988 lines) and the existing IR layer (src/ir/{select, from-ast, lower, builder, nodes, verify, integration}.ts ≈ 4000 lines plus src/codegen/statements/loops.ts:1456-2600), I'm flagging two issues with the issue-as-written:

### Issue 1: Spec assumes infrastructure that doesn't exist

The spec's §"Loop / block control terminators" claims:

> The lowerer maps the IR block-graph to Wasm structured control flow via the existing block-layout pass (no change). The block / loop Wasm wrappers come from lowerIrFunctionToWasm's structured-CFG recovery, which already handles br/br_if to reserved blocks.

This is incorrect. `src/ir/lower.ts:emitBlockBody` (line 731) **inlines** branch targets recursively. It has no Stackifier / structured-CFG recovery, no back-edge detection, no Wasm-loop emission. Worse, lines 779-787 explicitly forbid block-args on branches:

```ts
if (t.branch.args.length !== 0) throw new Error(`ir/lower: Phase 1-3 br does not support branch args (${func.name})`);
```

Adding loops to this lowerer requires either (a) full structured-CFG recovery, OR (b) a dedicated "structured loop" IR primitive that bypasses the CFG inliner.

### Issue 2: One PR is too large for the spec's scope

The spec's own §"Suggested staging within the slice" proposes 5 sub-steps (A-E) and says:

> Ship in three CI rounds (steps A+B, then C, then D+E) to keep regressions diagnosable.

The full implementation touches 7+ files, adds 7 IR instr variants, 12+ builder methods, 3 for-of strategies (vec / string / host iter), iter-close on break/return, null guards, mutable-local promotion for loop counters / element bindings — call it 1500-2500 lines plus tests. Slices 1-4 (already merged) all share the same lowerer; a botched loop-CFG change risks regressing strings, objects, closures, AND classes simultaneously.

## Decision: deliver the smallest valuable foundation

This PR delivers the loop-scaffold foundation + Step B (vec for-of array fast path) only.

**In scope:**
- New IR primitives:
  - `vec.len(vec)` → i32 (array length)
  - `vec.get(vec, index, elemType)` → elemType (array element)
  - `slot.read(slotIdx, type)` → type (Wasm local read — for mutable counters/accumulators)
  - `slot.write(slotIdx, value)` → void (Wasm local write)
  - `forof.vec` — high-level statement-level instruction that wraps a Wasm `block { loop { ... } }`, with the body's IR instrs emitted inline. Counter / length / element bindings are slot-allocated at the IR level.
- Selector recognises: `for (const x of arr) <statement>` where `arr` resolves to a known vec struct (Array<T> / tuple). Body must be a Phase-1 statement list (block / let / expr-statement / if / break / continue / return — no nested for-of / no labels in this slice).
- AST→IR lowering for the new IR primitives.
- Lowering pass emits the structured Wasm loop directly from `forof.vec` — sidestepping the missing CFG-recovery infrastructure.

**Deferred to follow-ups:**
- **#1169e-2** (Step C): host iterator protocol — `iter.new` / `iter.next` / `iter.done` / `iter.value` / `iter.return`. Maps to Map/Set/generator iteration.
- **#1169e-3** (Step D): native string fast path via `__str_charAt`.
- **#1169e-4** (Step E): iter-close on abrupt exit (break / return inside host-iter loop).

## Implementation notes (for review)

### Why a high-level `forof.vec` instr instead of CFG primitives

The spec proposed `iter.*` IR instrs that lower to host-import calls and a generic loop scaffold using br/br_if to reserved blocks. That requires structured-CFG recovery in lower.ts which would need to:
- Walk blocks in DFS order, detecting back edges
- Identify loop headers (blocks targeted by back edges)
- Emit Wasm `loop` wrappers around loop headers
- Translate `br <header>` to `br <wasm_depth>` (continue)
- Identify exit blocks (forward edges leaving the loop) and emit `block` wrappers
- Track Wasm structured-block depth during emission

That's a Stackifier-style algorithm. Implementing it correctly requires careful handling of irreducible CFGs, multi-exit loops, and nested loops — all areas where bugs cause Wasm validation failures, not test failures (i.e. silent module rejection at instantiation time, not the kind of bug that surfaces in vitest).

A `forof.vec` instr captures the loop's structure declaratively at the IR level. The lowerer emits a known-good Wasm pattern directly. The body's instructions are still real IR — optimization passes (constant-fold, DCE, simplifyCFG) can still rewrite them. The IR's SSA discipline is preserved within the body; mutable cross-iteration state (counter, element binding, accumulator) lives in slots.

This approach is consistent with how `closure.call`, `class.new`, and `box`/`unbox` work today: high-level IR primitives that lower to known-good Wasm sequences, with the lowerer handling the details.

### Slot mechanism

The IR gains a small "slot" concept: a Wasm local declared at function granularity, identified by a stable index. `slot.read(idx)` and `slot.write(idx, value)` access it.

Why slots and not block args:
- Block args require lowerer support for branch args (today rejected).
- Block args require the verifier to track block-arg flow across edges (today only intra-block).
- Slots map 1:1 to Wasm locals, which the lowerer already manages.

The from-ast layer promotes outer-scope `let`-bound variables to slots when they're written inside a for-of body. Reads emit `slot.read`; writes emit `slot.write`.

## Test coverage

- `tests/equivalence/ir-forof-vec.test.ts` — for-of over `number[]` summing, finding max, predicate filtering. Verifies the IR path is taken (via instrumentation) and matches the legacy path's output.
