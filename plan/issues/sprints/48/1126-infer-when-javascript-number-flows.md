---
id: 1126
sprint: 48
title: "Infer when JavaScript number flows can be safely lowered to int32 or uint32"
status: deferred
created: 2026-04-16
updated: 2026-05-02
priority: high
feasibility: hard
reasoning_effort: high
task_type: performance
area: codegen
language_feature: numeric-inference
goal: core-semantics
depends_on: [1124]
---
> **Deferred from Sprint 46 → Sprint 47 → Sprint 48.** Each sprint it competed
> with higher-urgency senior-dev work. S48 is the commit: this lands.

# #1126 — Infer when JavaScript number flows can be safely lowered to int32 or uint32

## Problem

The compiler already has several ways to emit `i32` in specific cases:

- explicit bitwise coercions such as `|0`
- builtin-specific lowerings such as `Math.clz32` / `Math.imul`
- legacy fast-mode heuristics

But there is no principled pass covering the broader question:

- when can a JavaScript `number` flow stay in a narrower integer domain
- when is that domain signed `int32`
- when is that domain effectively `uint32`
- when must the compiler widen back to full JS `number` / `f64`

Right now that decision is made piecemeal. As a result:

- some hot numeric paths stay in `f64` longer than necessary
- some optimizations are limited to explicit coercion syntax instead of proven
  numeric facts
- there is no single place to define the safety rules for `i32` vs `u32`
  lowering under JavaScript semantics

Issue `#1124` established that this reasoning does not fit cleanly in the
current AST-to-Wasm lowering path and should live in a proper middle-end.
This issue tracks the integer-domain part of that work.

## Why it matters

- hot loops and counters should not bounce through `f64` if the value domain is
  provably integral
- array/string lengths, indices, shift counts, hashes, and bitwise pipelines
  often naturally live in 32-bit integer domains
- unsigned flows matter for JavaScript operations such as `>>>`, `Math.clz32`,
  `Math.imul`, and index/length-style arithmetic
- fixes the root cause of the saturation bug tracked in #1236

## Goal

Define and implement a conservative inference pass that detects when JS
`number` values can safely be represented as:

- signed `int32`
- unsigned `uint32`

and keeps those values in an integer domain until a real semantic boundary
requires widening back to JS `number` / `f64`.

## Scope

This issue is broader than explicit `|0` patterns. It should cover:

1. inference from operations and value flow
2. distinction between signed and unsigned 32-bit domains
3. safe widening points back to generic JS number semantics
4. interaction with call boundaries, returns, closures, and loops

This issue does **not** need to solve arbitrary numeric range analysis or
perfectly infer all integer domains in dynamic JavaScript.

## Required questions

The implementation or design must answer:

1. Which operations constrain a value to `int32`?
2. Which operations constrain a value to `uint32`?
3. Which operations force widening back to generic JS number / `f64`?
4. When does "integral" still not imply safe `i32` lowering?
5. How should the compiler represent signed vs unsigned facts internally?
6. How do those facts propagate through loops, branches, and function calls?
7. At what boundaries must `uint32` be normalized back to JS number semantics?
8. How does this interact with existing explicit coercion syntax like `|0` and `>>> 0`?

## First-pass rules to support

Support at minimum:

- integer literals
- loop counters
- `+`, `-`, `*`, `%` when both operands are already in an integer domain and
  JS semantics are still preserved
- bitwise operators: `&`, `|`, `^`, `<<`, `>>`, `>>>`
- comparisons and branch conditions
- array/string lengths and indices
- builtin cases already known to be 32-bit-oriented

Conservatively widen on: `/`, fractional literals, floating-point `Math.*`
operations, mixed integer/float flows, host/API boundaries.

## Desired architecture

Build on the middle-end direction from `#1124`:

- TypeScript checker provides initial facts
- middle-end IR tracks numeric-domain facts on SSA values
- a propagation pass refines values to `f64`, `int32`, or `uint32`
- Wasm lowering materializes `i32` ops where the domain is proven safe
- boundary lowering inserts widening/coercion only where needed

## Acceptance criteria

- compiler distinguishes at least three states: `f64` | `int32` | `uint32`
- explicit `|0` and `>>> 0` patterns map into this framework (no isolated ad hoc handling)
- integer-domain facts propagate through simple loops and direct calls
- conservative widening on ambiguous semantics
- generated code for proven integer-domain hot paths is materially leaner than f64 path
- #1236 (saturation bug) is subsumed or explicitly tracked as out-of-scope
- design is consistent with the middle-end architecture proposed in `#1124`

## MLIR alignment

The integer-domain inference results **must be expressed as `TypeMap` entries**,
not as IR node mutations or ambient module-level maps. The `propagate()` contract
from #1231 applies here: a future MLIR optimizer that replaces the LatticeAtom
propagator must produce the same `TypeMap` shape, and the Wasm emitter is unchanged.

Concretely:
- The i32/u32 domain fact for a node is stored in the `TypeMap`:
  `typeMap.get(nodeId) → { numericDomain: "i32" | "u32" | "f64" }`.
- The Wasm emitter reads `typeMap.get(nodeId)?.numericDomain` to decide whether
  to emit `f64.add` vs `i32.add`.
- **Anti-pattern**: setting `node.inferredIntDomain = "i32"` on the AST node —
  that breaks MLIR replaceability. Route through `TypeMap`.

## Related

- #1120 — explicit bitwise-coerced loop patterns (subset of this)
- #1121 — whether a recursive numeric path is numeric at all (complementary)
- #1236 — accumulator saturation bug (root-cause fix here)
- #1124 — middle-end architecture direction

## Implementation Plan (architect-spec, 2026-05-03)

Author: senior-developer (Opus). Decomposed into six landable PRs so each
stage is independently bisectable and testable.

### Anchoring lessons from prior attempts

1. **#1236 — `i32 + i32 = f64` (NOT `i32`).** JavaScript's `+` on two
   safe-integer i32s can overflow into the safe-integer f64 domain
   (`2^31` fits in f64 mantissa; `i32.add` would wrap-around-trap). The
   correct rule: **arithmetic with both operands in `i32` widens the
   result to `f64`** unless the value is immediately re-coerced (`(a+b)|0`,
   shift, or stored to an `i32` slot). Bitwise / shift operators are the
   only ops that *preserve* the `i32` domain across arithmetic.
2. **#1231 contract.** The propagation pass writes ONLY into `TypeMap`.
   No `node.inferredIntDomain = "i32"` or sidecar maps keyed by
   `ts.Node`. MLIR replacement reads the same `TypeMap` shape.
3. **Selector-rejected functions stay legacy.** This pass adds two new
   `LatticeAtom` kinds (`i32`, `u32`); if propagation of those atoms hits
   a body the selector doesn't claim, fall back to `f64` for that
   function — never poison the legacy path with new domain facts.
4. **Bool already maps to `i32` Wasm.** `lowerTypeToIrType({kind:"bool"})`
   already returns `{kind:"val", val:{kind:"i32"}}` (line 920 of
   propagate.ts) — meaning `i32` as a *Wasm representation* exists today.
   What's missing is `i32` as a *lattice domain fact* for f64-typed
   values that happen to live in the integer subset.

### Domain semantics — what the lattice atoms mean

| Atom    | Wasm rep          | Domain invariant                                             |
|---------|-------------------|--------------------------------------------------------------|
| `f64`   | `f64`             | Generic JS number — may be ±0, NaN, ±Inf, fractional         |
| `i32`   | `i32`             | Integer in `[-2^31, 2^31)`, signed two's-complement          |
| `u32`   | `i32` (unsigned)  | Integer in `[0, 2^32)`, treated unsigned at every op site    |
| `bool`  | `i32` (0/1)       | Boolean — already supported, untouched                       |

`i32` and `u32` share the **same Wasm storage type** but are tracked as
distinct lattice atoms because the *operations* differ (`i32.shr_s` vs
`i32.shr_u`, comparison signedness, conversion to `f64`).

### Stage 1 — Lattice extension (~150 LoC, 1 PR)

**File**: `src/ir/propagate.ts`

Extend `LatticeAtom` to:
```ts
export type LatticeAtom =
  | { readonly kind: "f64" }
  | { readonly kind: "i32" }   // NEW
  | { readonly kind: "u32" }   // NEW
  | { readonly kind: "bool" }
  | { readonly kind: "string" }
  | { readonly kind: "object"; readonly fields: ... };
```

Update:
- `join()`: `i32 ⊔ f64 = f64`, `u32 ⊔ f64 = f64`, `i32 ⊔ u32 = f64`
  (signed/unsigned mismatch widens — values like `2^31` differ in sign).
  `i32 ⊔ i32 = i32`, `u32 ⊔ u32 = u32`. Cross-kind with non-numeric
  atoms still produces `union` or `dynamic` per existing rules.
- `lowerTypeToIrType`: `i32`/`u32` both → `{kind:"val", val:{kind:"i32"}}`
  but **carry the signedness in the IR shape** (new field
  `IrValType.signed?: boolean`, default `true`). The signedness sticks
  to the value so emit sites pick `f64.convert_i32_s` vs `_u`.
- New constants `I32: LatticeType`, `U32: LatticeType`.

Tests: `tests/ir-propagate-i32.test.ts` — pure-unit tests of `join`,
`inferExpr` with literal/var/binop seeds, no compile.

**Acceptance**: lattice tests pass; no behavior change in any compile
test (no producers of `i32`/`u32` atoms yet).

### Stage 2 — Inference rules (~400 LoC, 1 PR)

**File**: `src/ir/propagate.ts` — extend `inferExpr` and `seedParamType`.

Producer rules (an op produces `i32`/`u32`):
| Source                                          | Domain |
|-------------------------------------------------|--------|
| Integer numeric literal in `[-2^31, 2^31)`      | `i32`  |
| Integer numeric literal in `[2^31, 2^32)`       | `u32`  |
| `e \| 0`, `e & X`, `e ^ X`, `e << X`, `e >> X`  | `i32`  |
| `e >>> 0`, `e >>> X`                            | `u32`  |
| `~e`                                            | `i32`  |
| `Math.clz32(e)`                                 | `u32`  |
| `Math.imul(a, b)`                               | `i32`  |
| `array.length`, `string.length`                 | `u32`  |
| Loop counter pattern: `for (let i=0; i<N; i++)` | `i32`  |
|   where `i` is integer-seeded and never widened |        |
| TS annotation `i32` / `u32` (from #939 native)  | `i32` / `u32` |

**Critical preserve/widen rules** (the #1236 fix):
| Op                   | Both sides | Result |
|----------------------|-----------|--------|
| `+`, `-`, `*`, `%`   | `i32, i32` | **`f64`** (overflow → JS number widening) |
| `+` (string)         | `string, *` | `string` |
| `&`, `\|`, `^`        | `*, *`    | `i32`  (JS ToInt32 forces narrow) |
| `<<`, `>>`           | `*, *`    | `i32`  |
| `>>>`                | `*, *`    | `u32`  |
| `<`, `<=`, `>`, `>=` | `i32, i32` | `bool` (cmp uses `i32.lt_s` etc.) |
| `<`, `<=`, `>`, `>=` | `u32, u32` | `bool` (cmp uses `i32.lt_u`)        |
| `==`, `===`          | numeric/numeric | `bool` |
| `/`                  | any       | `f64`  (always widen — fractional possible) |
| `**`                 | any       | `f64`  |
| `Math.{abs,sign,...}` | `i32`    | `i32`  (only safe when result domain proven) |
| `Math.{floor,ceil,round,trunc}` | `f64` | `i32` *if* in safe range, else `f64` (conservative: `f64`) |

This is the heart of the spec: **arithmetic widens, bitwise narrows.**
The pattern `(x|0) + 1` will infer `i32` for `(x|0)`, `f64` for the
`+1`, then if it's stored to a counter with a coerce-back at top of
loop (`i = (i+1)|0`), the loop body sees `i32` again.

Loop counter detection (the #1120 sub-pattern, lifted into propagate):
```ts
// In a `let i = K` declaration where K is i32-domain, and the only
// updates to `i` inside the enclosing block are `i = i + LIT` or
// `i++` / `i--`, AND the only loop-exit comparison narrows to i32-cmp,
// treat `i` as i32-domain across the loop body.
```
This requires light SSA-style tracking — implement as a per-function
flow pass on top of the existing scope walker.

Tests: `tests/ir-propagate-i32-rules.test.ts` — for each producer rule
and each preserve/widen rule, build a synthetic body, call `propagate`,
assert the resulting `TypeMap` entry's atoms.

**Acceptance**: TypeMap-shape tests pass; #1236 saturation repro now
infers `f64` for the accumulator (sentinel test stays passing).

### Stage 3 — Emitter integration (~500 LoC, 1 PR — biggest one)

**File**: `src/ir/lower.ts` (IR-claimed functions) +
`src/codegen/expressions.ts` (legacy fallback).

IR side:
- New `IrValType.signed?: boolean` field threaded through.
- `case "binary"` in `lower.ts:602` now consults each operand's
  `IrType.val.kind`. If both operands are i32-shaped:
  - bitwise/shift: emit `i32.{and,or,xor,shl,shr_s,shr_u}` directly
    (skip the JS-bitwise scratch dance at lines 610-648 — this is
    where the perf win shows up).
  - arithmetic: per the rule above, emit `f64.convert_i32_s/u` on
    BOTH operands, then `f64.add` / `f64.sub` / `f64.mul`. The
    propagated result type is `f64`. (No `i32.add` here — that's the
    #1236 trap.)
  - compare: emit `i32.{lt,le,gt,ge}_{s,u}` based on signedness,
    matching the JS comparison semantics (both `i32` → signed cmp;
    both `u32` → unsigned cmp; mixed → widen and `f64.lt`).
- Loop counter slots: when a `let` lowers to a local of `IrType.val.i32`
  (rather than `f64`), the local declaration emits `i32` instead.

Legacy side (for selector-rejected functions where TypeMap still has
i32 facts — e.g., recursion):
- `compileBinaryOp` reads `typeMap.get(node.id)?.numericDomain` and
  picks the same i32 fast path. **Anti-pattern guard**: if the legacy
  path can't reach `typeMap` (some emit sites don't have it threaded),
  fall back to `f64` — never silently miscompile.
- New helper `coerceToInt32(operand, signed: boolean)` in
  `type-coercion.ts` for the boundary cases.

Boundary materialization rule:
- An `i32`-domain value crossing into an `f64`-typed slot
  (param/return/closure-cap/struct-field): emit `f64.convert_i32_s/u`
  at the boundary. Track this via a `widenAtBoundary` flag in
  `LowerCtx`.
- An `f64`-domain value flowing into an `i32`-typed slot: emit the
  full JS `ToInt32` (the sequence at `expressions.ts:1989-2009`).

Tests: `tests/issue-1126-emit.test.ts` — equivalence-style tests for
each rule, comparing legacy vs IR output for hot kernels:
- bitwise loop (FNV-1a hash, CRC32, popcount)
- counter loop (sum 1..N)
- mixed (`(a+b) | 0` reductions)
- saturation guard (the #1236 case must still produce wrong-but-JS-correct
  f64 result, not i32-trapped value).

**Acceptance**: all equivalence tests pass; spot-check generated wat
shows `i32.and` / `i32.shl` instead of the scratch-local dance for
proven-i32 bitwise ops; #1236 saturation test stays green.

### Stage 4 — Boundary conversions & call propagation (~150 LoC, 1 PR)

**Files**: `src/ir/propagate.ts` (call-site arg/return narrowing),
`src/ir/lower.ts` (call lowering), `src/codegen/index.ts` (legacy).

- Function-param i32 facts already inferred by Stage 2's worklist now
  affect emit: if `f(x: number)` is inferred `params: [i32]`, the IR
  generates a function with an `i32` param, AND every call site
  narrows the f64 arg to i32 before the call.
- Return-type i32 facts: callee returns i32-Wasm, callers receiving
  into an f64 slot get a `f64.convert_i32_s` stub.
- Cross-function narrowing must be conservative: only collapse to
  i32 when ALL inferred call sites for that param land in `i32`/`u32`
  domain (otherwise widen). The existing worklist in `buildTypeMap`
  already monotone-joins; this just needs the new atoms wired in.

Tests: `tests/issue-1126-cross-fn.test.ts` —
- `function add(a, b) { return a + b }` called with `i32` args: param
  type stays `f64` (because i32+i32 → f64 in body).
- `function shl(x, n) { return x << n }` called with `i32` args: param
  type narrows to `i32`, return narrows to `i32`, all call sites pre-
  narrow.

**Acceptance**: cross-function tests pass; no test262 regression
(`Numbers/intrinsics` cluster is the high-risk path).

### Stage 5 — Tests + benchmarks (~300 LoC, 1 PR)

**Files**: `tests/issue-1126.test.ts`,
`benchmarks/perf-suite/int32-kernels.bench.ts`.

- Benchmarks for: FNV-1a hash, simple PRNG (xorshift32), matrix index
  arithmetic, loop counter sum. Compare wasm vs js wall-clock and IR
  vs legacy compile output bytes.
- Acceptance-criteria coverage tests (one per `## Acceptance criteria`
  bullet in this issue file).
- A `pseudo-extern` registry sweep test confirming `array.length` etc.
  produce `u32` atoms.

**Acceptance**: benchmarks recorded as new baseline; acceptance-tests
all green.

### Stage 6 — Peephole polish (~100 LoC, 1 PR)

**File**: `src/codegen/peephole.ts`.

- Eliminate `f64.convert_i32_s` immediately followed by JS-`ToInt32`
  sequence (round-trip).
- Eliminate `i32.add` followed by `f64.convert_i32_s` followed by
  `JS-ToInt32` when surrounded by an outer `|0` (composite collapse).
- Don't touch the #1236 widen path — peephole must not re-narrow what
  Stage 3 deliberately widened.

Tests: `tests/peephole-i32-roundtrip.test.ts` — synthetic Wasm
sequences, assert collapse.

**Acceptance**: peephole tests green; benchmark improvements visible
on hot kernels.

### Risk register & mitigation

| Risk | Mitigation |
|------|------------|
| `i32+i32 → i32` regression like #1236 | Stage 2 explicitly widens arithmetic to f64; sentinel test in #1236 stays as canary |
| Test262 `Number` cluster regression | Land Stage 1+2 alone first, watch CI; if any regression, hold stages 3+ until root-caused |
| Cross-fn worklist non-termination | Existing `MAX_ITERS = 50` cap covers this; new atoms are still on a finite lattice |
| Legacy/IR divergence on i32 slot types | All legacy emit sites that consult `typeMap.numericDomain` must default-to-f64 on missing entry |
| MLIR drift | Every lattice/TypeMap change goes through `propagate.ts`; downstream consumers read TypeMap shape only |

### Out of scope (for this slice — defer to follow-ups)

- `i64` / `BigInt` domain (separate issue)
- Range-narrowing (e.g., `i & 0xFF` known to fit in `i8`) — needs
  proper interval analysis, much heavier
- Dynamic-property numeric-key fast path (`obj[i32]` → typed array
  index) — interacts with object-shape inference, separate slice
- Loop-induction-variable strength reduction — `wasm-opt` already
  does most of this post-codegen; revisit if benchmarks show gap

### Total

~1,600 LoC across 6 PRs, sequenceable. PRs 1+2 are pure additions
(no behavior change without #3); PR 3 is the largest and the only one
that can produce a perf regression if the rules are wrong; PRs 4–6
are polish.
