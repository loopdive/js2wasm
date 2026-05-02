---
id: 1167
title: "SSA IR Phase 3 — optimization passes (meta issue — see 1167a/b/c)"
status: ready
created: 2026-04-22
updated: 2026-04-28
priority: high
feasibility: hard
reasoning_effort: max
task_type: meta
area: codegen
language_feature: compiler-internals
goal: compiler-architecture
depends_on: [1131, 1166]
---
# #1167 — SSA IR Phase 3: optimization passes (meta)

## Split

Architect review (2026-04-22) identified that the original spec was written
against a broader IR than currently exists. Four of six passes have no surface
to operate on under the current 4-point lattice + `IrType = ValType`. Split
into three independently-dispatchable issues:

| Issue | Passes | Sprint | Status |
|-------|--------|--------|--------|
| [#1167a](../sprints/43/1167a.md) | constant-fold, dead-code, simplify-cfg | 43 | ready |
| [#1167b](../sprints/43/1167b.md) | inline-small | 43 | ready (after 1167a) |
| [#1167c](../backlog/1167c.md) | monomorphize, tagged-unions | backlog | blocked on #1168 (IR frontend widening) |

Escape analysis deferred to Phase 3d — no struct/closure allocation in IR yet.

## Original spec (for context)

## Context

Phase 1 (#1131) built the SSA IR scaffold and builder. Phase 2 (#1131 §Phase 2)
added interprocedural type propagation and closed-world integer specialization
(#1166). Phase 3 uses the stable call graph and type facts to implement the
optimization passes that were impossible without a middle-end IR.

Every `feasibility: hard` issue in the `performance` goal names the same
missing piece: a place to run typed program passes between the TypeScript
checker and Wasm emission. That place now exists. Phase 3 populates it.

## Passes — in implementation order

### Pass 1 — `src/ir/passes/inline-small.ts`

**Replaces**: `InlinableFunctionInfo` in `src/codegen/context/types.ts:70–79`
(current mechanism splices already-emitted `Instr[]` at call sites — inlined
bodies don't participate in type propagation and interact badly with
`addUnionImports` index shifting).

**New behaviour**: inline small function bodies on the IR before lowering.
Inlined bodies participate in the propagation pass — their type facts flow
into the caller, enabling further specialization.

Threshold: inline when callee has ≤ N IR instructions (tunable; start with
N = 10) and is not recursive.

### Pass 2 — `src/ir/passes/monomorphize.ts`

**Addresses**: #744 (function monomorphization for polymorphic call sites).

When a direct call's argument types differ across call sites, clone the callee
for each consistent type signature. Each clone gets a distinct `IrFuncRef` and
flows through lowering as a separate Wasm function.

Example: `identity(x)` called as both `identity(42)` (f64) and
`identity("hi")` (string) → two clones: `identity$f64` and `identity$string`.

Guard: only monomorphize when the clone count is bounded (≤ 4 variants) and
the callee body is below a size threshold. Polymorphic call sites that don't
meet the threshold fall back to `externref`.

### Pass 3 — `src/ir/passes/tagged-unions.ts`

**Addresses**: #745 (tagged union representation).

When a value's propagated type is a `union` whose members all map to
Wasm-representable types (e.g. `f64 | bool`, `f64 | null`), represent it as a
WasmGC struct with a tag field instead of `externref`:

```wat
(type $union_f64_bool (struct (field $tag i32) (field $val f64)))
```

`box`/`unbox` IR instructions lower to `struct.new` + tag branch instead of
host import calls (`__box_number`, `__unbox_number`). Eliminates the
JS-boundary round-trip for common union patterns.

### Pass 4 — `src/ir/passes/constant-fold.ts`

Fold constant IR values at compile time:
- `prim add(const 1, const 2)` → `const 3`
- `cond_branch (const true) then bb1 else bb2` → `branch bb1`
- Enables dead-block elimination as a follow-on

Straightforward on SSA — each value has exactly one definition site.

### Pass 5 — `src/ir/passes/dead-code.ts`

Eliminate unreachable blocks (blocks with no predecessors after constant
folding) and unused values (values with no uses). Distinct from the backend
`dead-elimination.ts` which operates on Wasm imports/types.

### Pass 6 — `src/ir/passes/escape-analysis.ts`

**Addresses**: #747 (escape analysis for stack allocation).

Mark allocations (`closure`, `struct.new` equivalents) whose resulting value
does not escape the enclosing IR function. Non-escaping allocations can be
lowered to stack-local WasmGC structs or, once the Wasm GC proposal provides
stack allocation, to stack frames.

This pass is last because it depends on the call graph being stable after
monomorphization (escapes through cloned callees are narrower than through
the original polymorphic callee).

## Repair passes to kill

Once Phase 3 is complete for IR-path modules, these backend repair passes
become dead weight for those functions:

| Pass | File | Lines | Status after Phase 3 |
|---|---|---|---|
| `stackBalance` | `src/codegen/stack-balance.ts` | 2,512 | Downgrade to debug assertion for IR-path modules |
| `fixupStructNewArgCounts` | `src/codegen/fixups.ts` | ~200 | Eliminated — IR lowerer emits correct struct ops |
| `fixupStructNewResultCoercion` | `src/codegen/fixups.ts` | ~300 | Eliminated — types are resolved before lowering |
| Most of `peepholeOptimize` | `src/codegen/peephole.ts` | 213 | Retain only patterns not covered by constant-fold/dead-code |

The legacy AST→Wasm path keeps all repair passes intact until it is retired.

## Pipeline after Phase 3

```
TypedAST
  → buildIrModule (Phase 1)
  → propagateTypes (Phase 2)
  → inlineSmall          ← Phase 3
  → monomorphize         ← Phase 3
  → taggedUnions         ← Phase 3
  → constantFold         ← Phase 3
  → deadCode             ← Phase 3
  → escapeAnalysis       ← Phase 3
  → lowerToWasm
  → backend repair passes (legacy, shrinking)
  → emit
```

## Key files

- `src/ir/passes/` — **new directory**, one file per pass
- `src/ir/integration.ts` — wire passes into the pipeline after `propagateTypes`
- `src/ir/nodes.ts` — ensure `IrType` has `union` members and `boxed` variants
- `src/codegen/stack-balance.ts` — downgrade to assertion for IR-path functions
- `src/codegen/fixups.ts` — gate struct fixups behind `!irPath` flag

## Suggested implementation order

1. `constant-fold.ts` + `dead-code.ts` — simplest, unblocks others
2. `inline-small.ts` — replaces existing mechanism, validates IR pipeline
3. `monomorphize.ts` — highest test262 impact (#744)
4. `tagged-unions.ts` — eliminates `__box_number`/`__unbox_number` for unions (#745)
5. `escape-analysis.ts` — most complex, lowest immediate test262 impact

Each pass is independently dispatchable once the previous one is stable.

## Acceptance criteria

- All six passes implemented in `src/ir/passes/`
- `npm test -- tests/equivalence.test.ts` passes with no regressions
- `stackBalance` downgraded to assertion for IR-path modules (no behaviour change)
- `fixupStructNewArgCounts` / `fixupStructNewResultCoercion` gated off for IR-path
- Test262 pass rate target: low-to-mid 60s (up from 56.7% baseline)
- Each of #744, #745, #747 closeable after their respective pass ships

## Related issues

- #1131 — Phase 1 + Phase 2 (prerequisite, merged)
- #1166 — closed-world integer specialization (prerequisite)
- #744 — monomorphization (addressed by Pass 2)
- #745 — tagged union representation (addressed by Pass 3)
- #747 — escape analysis (addressed by Pass 6)
- #743 — whole-program type flow (prerequisite groundwork)

## Architect Review

(Reviewer: architect agent, 2026-04-22. Sources: `src/ir/{nodes,propagate,select,from-ast,lower,integration,types}.ts`, `src/codegen/{fixups,stack-balance,peephole,index}.ts`, `benchmarks/results/runs/index.json`.)

### TL;DR

The six passes are individually sensible, but the spec is written as if the IR frontend covers the whole module. Today it doesn't: `planIrCompilation` claims only the narrow Phase-1 numeric/bool tail shape, and `propagate.ts` collapses anything polymorphic to `dynamic`. Under the current frontend, four of the six proposed passes (`monomorphize`, `tagged-unions`, `escape-analysis`, and much of `inline-small`) have **no surface to operate on**. Before this issue is sprintable we need either (a) a parallel frontend-widening spec covering unions, objects, closures, and cross-module calls, or (b) an honest rescoping to "constant-fold + dead-code + inline-small (direct numeric calls only)" with the other three deferred.

### 1. Ordering / dependencies between passes

- **Contradictory ordering inside the doc.** "Passes — in implementation order" lists inline(1) → mono(2) → unions(3) → CF(4) → DCE(5) → escape(6). "Suggested implementation order" below lists CF(1) → inline(2) → mono(3) → unions(4) → escape(5) and omits DCE. Tech lead / dev will not know which to follow. Pick one.
- **`inline-small` claims "inlined bodies participate in the propagation pass" but propagation is Phase 2 — it has already run.** Either the pipeline re-runs `propagateTypes` after inlining (not specified and expensive), or this sentence is false. This needs a concrete statement: either (a) inline emits seeds into the TypeMap, (b) we re-run propagation, or (c) inlined code is opaque to propagation and the sentence is removed.
- **`monomorphize` has the same problem one level down.** Cloning produces new `IrFuncRef`s (`identity$f64`, `identity$string`); neither is in the `TypeMap` produced by `buildTypeMap` (`src/ir/propagate.ts:111`), so subsequent passes that consult the TypeMap see them as missing. The spec needs to say who seeds the cloned signatures into `calleeTypes` / the override map used by `src/codegen/index.ts:351` (`overrideMap`).
- **Constant-fold → dead-code is correct**, but both should probably re-run after inline/mono to capture newly-exposed constants (classic inline-then-fold). The doc only runs each pass once.
- **Escape analysis ordering argument is sound** (depends on stable call graph post-mono), but the `closure` and `struct.new` allocations it reasons about are **not in today's `IrInstr` union** (`src/ir/nodes.ts:224-232` — only `const | call | global.get | global.set | binary | unary | select | raw.wasm`). Pass 6 can't be written against the current IR.

### 2. Inconsistencies with the actual Phase 2 code

Cite-level items the dev will trip on:

- **`IrType` is just an alias for `ValType`** (`src/ir/nodes.ts:58`: `export type IrType = ValType;`). `ValType` (`src/ir/types.ts:79-93`) has **no `union` kind and no `boxed` variant**. The bullet "ensure `IrType` has `union` members and `boxed` variants" (line 140) is a one-line ask that is actually a substantial IR type-system change. It needs its own section: what the new `IrType` shape is, how it lowers to `ValType`, how `verifyIrFunction` (`src/ir/verify.ts`) learns about it, and how `nodes.ts` distinguishes "middle-end" types from backend `ValType`.
- **No `box` / `unbox` IR instructions today.** The "`box`/`unbox` IR instructions lower to `struct.new` + tag branch" sentence (Pass 3) presupposes instructions that don't exist. `IrInstr` must be extended with new kinds; `from-ast.ts` must emit them; `lower.ts:177-216` (`emitInstrTree`) must handle them; `verify.ts` must typecheck them. None of this is in scope-text.
- **`LatticeType` is 4-point, not union-aware.** `src/ir/propagate.ts:80-84` defines `unknown | f64 | bool | dynamic`. Every call site / return that is not f64-or-bool collapses straight to `dynamic`. For `monomorphize` to have polymorphic call sites to reason about, the lattice needs "string", "object(kind)", "union-of-{…}", etc. — propagation needs to be widened first. This is probably a bigger task than any single Phase-3 pass.
- **The selector doesn't claim any function whose body touches a union / object / closure / property access.** `src/ir/select.ts:252-283` (`isPhase1Expr`) accepts only literals, identifiers, unary/binary numeric ops, conditional, and direct CallExpressions. No member access, no `new`, no `typeof`, no string ops. So the "polymorphic call site" that `monomorphize` is supposed to specialize **cannot currently reach the IR** — if it were polymorphic in any interesting way, the selector would reject the caller.
- **Line-count claims for repair passes are off**: `fixups.ts` is 986 lines total; `fixupStructNewArgCounts` is ~130 lines (483–613), `fixupStructNewResultCoercion` is ~160 lines (613–772). The numbers in the table (~200 / ~300) overstate.
- **`InlinableFunctionInfo` is not "replaced" by Pass 1**: it sits in the *legacy* path (`src/codegen/context/types.ts:80-89`, used by `src/codegen/index.ts:6286` in the legacy emitter). The IR path already lowers calls via `IrInstrCall` and never reads `InlinableFunctionInfo`. Pass 1 is **new inlining on the IR side**; the legacy mechanism keeps running for legacy-path functions. "Replaces" misleads.

### 3. Missing passes / risks not called out

- **Clone explosion composition**: the ≤4-variants-per-callee guard composes multiplicatively. A → B → C each with 4 variants = 64 C-clones. Real budget must be total-module-growth (e.g. "monomorphization may not grow total IR instruction count by >1.5×") not per-callee.
- **Propagation staleness after monomorphize**: after cloning, the ORIGINAL function's type facts become a join over fewer call sites and may narrow. The spec does not say whether propagation re-runs on the post-mono call graph. For recursive clones this materially changes what's provable.
- **Selector re-eligibility after inlining**: inlining a non-IR callee into an IR caller requires the callee to be IR-claimable *and* for the inliner to translate the callee's body. The inliner can only inline IR→IR; it cannot inline a legacy-path body into an IR function. The spec doesn't say this. If both caller and callee are IR-path, inlining is fine — but the call-graph closure in `select.ts:92-118` guarantees this only for functions the selector already claimed. Adds no new surface.
- **CSE / redundancy elimination** — not proposed. SSA makes it ~30 lines of code and would catch `fib(n-1) + fib(n-2)` kinds of pattern (not useful here, but common elsewhere) and common param reads. Low effort, medium value. Worth adding.
- **Missing pass: simplifycfg**. After constant-fold + dead-code, empty blocks and single-successor chains should be merged. The current `lower.ts` expects a narrow CFG shape (`src/ir/lower.ts:218-265`) — leftover empty blocks will either break it or emit redundant `if/else` wrappers.
- **No test strategy**. Each pass needs unit tests at the IR level (`tests/ir/*.test.ts` or similar); equivalence tests alone won't show where a pass fires. The acceptance criteria only cites `equivalence.test.ts` passing with no regressions.

### 4. Repair passes — is the "kill" list accurate?

- **`stackBalance` (2,512 lines) — "downgrade to debug assertion for IR-path modules"** misunderstands the pass. `stackBalance` in `src/codegen/index.ts:495` runs on the whole `WasmModule`, iterating over ALL functions together. There is no notion of "IR-path module" — modules mix IR-path and legacy-path functions (the IR path rewrites a handful of function bodies in-place, per `src/ir/integration.ts:108-115`). Per-function gating would require tagging each `WasmFunction` with its origin and threading that flag through `stackBalance`. That tagging doesn't exist. The proposed "downgrade" is at minimum two sub-issues (add the flag, gate the pass), and probably won't save time unless the IR covers the majority of functions — which it doesn't today.
- **`fixupStructNewArgCounts` / `fixupStructNewResultCoercion`** never run against IR-emitted code because **the IR path currently never emits `struct.new`** (the `IrInstr` union has no struct ops). So these fixups are already no-ops for IR-path functions — "Eliminated" is overclaiming; what actually happens is the fixup iterates the body and finds nothing to repair. Zero wall-clock win. The kill is justified only after the IR grows struct allocation.
- **`peepholeOptimize`** — retain justification is correct, though the dominant pattern (`ref.as_non_null` after `ref.cast`) is emitted by the legacy path's type-coercion helpers, not by `lower.ts`. So there's no overlap to remove — the pass is essentially already IR-neutral.

**Net:** the "repair passes to kill" table is aspirational rather than actionable in the Phase-3 timeframe. Either defer it to a later phase (after the IR frontend covers 50%+ of emitted code) or rescope to "instrument the passes to report no-op runs for IR-path functions so we can track headroom".

### 5. Test262 target (low-to-mid 60s from 56.7%)

Latest recorded run: 24,483/43,172 = 56.7% (`benchmarks/results/runs/index.json`, gitHash `14ed88c4`). "Low-to-mid 60s" = +1,500 to +3,500 passing tests. **This is not realistic for these six passes.**

Why:
- The IR frontend claims a vanishingly small fraction of test262 code (numeric/bool tail-shaped functions, call-graph-closed). Typical test262 tests are spec-conformance checks on strings, iterators, Symbol, Proxy, Date, RegExp, TypedArray — none of which reach the IR path today.
- Tagged-union codegen will speed up some union patterns but won't flip failing tests to passing unless the current failure is a boxing-related CE. Box/unbox is rarely the direct cause of a test262 FAIL.
- Monomorphization and inlining improve throughput; they do not add language features.
- Historically, each test262 percentage point has come from category-level fixes (e.g. iterator protocol, Symbol.iterator, strict mode). None of these passes address such categories.

Realistic estimate for Phase 3 alone: **+0 to +300 tests**, mostly from marginal CE → PASS flips when a recursive numeric kernel hits a throughput cliff on the legacy path. The claimed target should be **reframed as a microbenchmark / performance goal** (e.g. "fib(30) runtime halves", "mandelbrot kernel runs with zero externref boxing") rather than a test262 number. Keep test262 as "no regressions".

### 6. Things that would send a developer down the wrong path

Concrete landmines:

1. **`src/ir/nodes.ts` needs a non-trivial type-system extension**, not a small edit. The one-line "ensure IrType has `union` members" (line 140) will be read as "add a couple of cases"; in reality it requires rethinking IrType as middle-end-typed-with-lowering-to-ValType, updating the verifier, and wiring propagation to produce richer lattice types.
2. **`monomorphize` against a 4-point lattice** is a contradiction. Without union / object / string lattice points, there are no "polymorphic" call sites to specialize — propagation already committed to `dynamic`. Dev will spend time writing a pass that never fires.
3. **`tagged-unions` without `box`/`unbox` IR instructions** — dev will introduce these on their own and likely pick incompatible encodings vs. whatever gets standardized later. Define the instruction shape and lowering up front.
4. **WAT-syntax snippet (line 70)** — the codebase doesn't parse WAT anywhere. Types are emitted via `FuncTypeDef` / `StructTypeDef` / `FieldDef` in `src/ir/types.ts:39-77`. A dev might look for a WAT parser or copy the snippet literally into a .wat file. Replace with a TS snippet constructing a `StructTypeDef`.
5. **"backend repair passes (legacy, shrinking)"** in the pipeline diagram (line 132) suggests the IR path skips them. It doesn't — `stackBalance`, `fixups`, `peepholeOptimize` run on the final `WasmModule` including IR-rewritten bodies. Without per-function gating, they're not shrinking.
6. **Acceptance criterion "Each of #744, #745, #747 closeable after their respective pass ships"** — #744 / #745 / #747 ask for the feature to be *effective*, not merely present as a no-op-ready pass. A pass that never fires because the frontend doesn't expose polymorphic call sites does not close #744.

### Recommended rework before dispatch

Minimum edits to make this sprintable:

1. **Split this issue into three**:
   - `#1167a` — IR hygiene passes: `constant-fold.ts` + `dead-code.ts` + `simplify-cfg.ts`. No frontend changes required. Target: no regressions, measurable on existing IR-path fib/factorial benchmarks.
   - `#1167b` — `inline-small.ts` (IR-side, direct-call-only). Requires an inlining policy for the `calleeTypes` map. Target: fib-style calls halve their call overhead.
   - `#1167c` — (depends on widened frontend) `monomorphize.ts` + `tagged-unions.ts`. Blocked until a "`propagate.ts` extension" issue covers unions, strings, and objects as lattice points AND `IrType` / `IrInstr` grow to carry them.
   - Escape analysis deferred further — no struct/closure allocation in the IR yet.
2. **Rewrite Pass 3 spec** with concrete `IrInstr` additions (`box`, `unbox`, `tag.test`), a TS-level `StructTypeDef` snippet for the union struct, and a lowering section showing how `box` becomes `struct.new` + tag.
3. **Reframe the test262 target** as "no regressions; performance improvements measured by microbenchmarks" and set a specific performance criterion (e.g. `bench/fib.ts` < N ms).
4. **Fix the ordering contradiction** between "Passes — in implementation order" and "Suggested implementation order".
5. **Remove / rescope the repair-pass kill list** — either defer to a later phase or rewrite as "add instrumentation to measure how often these passes are no-ops for IR-path functions".
6. **Add a unit-test line** to acceptance criteria: every new pass ships with targeted IR-level tests that exercise the transformation in isolation.
