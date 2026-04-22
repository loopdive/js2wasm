# senior-dev session — #1131 SSA IR Phase 2

## Session window
- Started: 2026-04-22
- Ended: 2026-04-22 (shutdown by team-lead after merge)
- Agent: senior-developer (Opus, max reasoning)

## What I worked on

Issue **#1131 Phase 2**: interprocedural type propagation for the middle-end SSA IR. Goal was to make `fib-recursive.js` compile with `fib: (f64) → f64` and zero externref boxing on the recursive hot path, even though `fib`'s parameter is untyped in source.

## Outcome

**Shipped.** PR #258 merged as commit `42b4818c7b9c727b608a154671b5a676bbc2d0ce`.

- Branch: `feat/ir-phase2` (now deleted)
- Commit on branch: `b811df115`
- Merge commit on main: `42b4818c7`
- CI passed with zero regressions (24483 pass, matching baseline).

## Files changed (+1362 / -56)

| File | Change |
|------|--------|
| `src/ir/propagate.ts` | **new** — `buildTypeMap` worklist fixpoint propagation |
| `src/ir/select.ts` | TypeMap support, CallExpression, call-graph closure, early-return-if |
| `src/ir/from-ast.ts` | overrides + calleeTypes, CallExpression → IrInstrCall, early-return-if lowering |
| `src/ir/integration.ts` | threads overrides + calleeTypes to lowerer |
| `src/codegen/index.ts` | runs buildTypeMap before selection, resolves per-position IR types |
| `src/compiler.ts` | `experimentalIR` default flipped to ON |
| `tests/issue-1131.test.ts` | **new** — 8 tests for Phase 2 |
| `tests/ir-scaffold.test.ts` | updated selector expectation (withIfNoElse) |
| `plan/issues/backlog/1131.md` | "Phase 2 Implementation Notes" section added |

## Key design decisions (record for future maintainers)

### 1. Lattice: `unknown → {f64, bool} → dynamic`

Four-point lattice. `unknown` is bottom (joins grow into it); `dynamic` is top (absorbing). The join is monotone so fixpoint terminates; I also cap iterations at 50 as a safety valve.

### 2. Optimistic `unknown` at operator sites

Arithmetic operators treat `unknown` operands as f64-compatible — `unknown + unknown → f64`. Without this, recursive kernels get stuck: `fib.returnType` starts `unknown`, so `fib(n-1) + fib(n-2)` stays `unknown` forever, and the selector never claims fib.

With optimism, iteration 1 gives `fib.returnType = f64` (because arithmetic forces it); iteration 2 confirms it transitively (now `fib(n-1)` definitely returns f64). Fixpoint.

**Why this is safe**: if later iterations refine the operand types and one becomes concrete-but-incompatible (e.g. `bool`), the operator falls to `dynamic`, the function fails selection, legacy takes over. No correctness issue.

### 3. Seed-authority for concrete return seeds

When a function has `f: (x: number): number { const y = doSomething(x); return y; }`, our body walker may produce `dynamic` for `return y` because we can't fully infer `y`'s type through `doSomething`. Blindly joining would corrupt the seed: `f64 ⊔ dynamic = dynamic`, and we'd drop the function.

Fix: if the seed is already concrete (`f64`/`bool`) and body inference yields `dynamic`, **keep the seed**. For functions whose seed is `unknown`, we fall through to the normal join — so genuine "returns a string" evidence still correctly produces `dynamic`.

### 4. Call-graph closure (critical safety invariant)

The IR path REPLACES a function's `typeIdx` on the Wasm module record. If a legacy-compiled caller has already emitted `call $f` with the OLD signature (typically `(externref) → externref`), the post-IR module fails Wasm validation.

Mitigation: after individual-claim computation, iteratively drop any claimed function whose any local caller OR any local callee isn't also claimed. Guarantees every cross-function edge in the module is legacy↔legacy or IR↔IR.

This is why extending the IR to more shapes doesn't cascade into regressions — if the IR can't claim the entire connected component of an annotated function, it claims nothing from that component.

### 5. Early-return-if statement shape

The canonical `fib` body is `if (n <= 1) return n; return <recursive>;`. This is an if-WITHOUT-else followed by a fall-through return. I structurally reinterpret it as `if (cond) <then> else { <rest> }`: in the selector's shape check AND in the lowerer (which reserves two block IDs, emits `br_if`, and recursively lowers the remaining statements into the else-arm block).

### 6. IR-on-by-default via `!== false`

`options.experimentalIR !== false` means:
- `undefined` → on (default)
- `true` → on
- `false` → off (explicit escape hatch)

The explicit-off path is required by `tests/ir-numeric-bool-equivalence.test.ts` and friends, which compile the same source twice (legacy + IR) and compare runtime outputs. Without the escape hatch these divergence tests couldn't run.

## What's NOT in Phase 2 (filed as follow-ups)

- `generateModuleMulti` does not yet route through IR. Multi-source compiles (WASI, test262 paths) always go legacy. → Phase 2.5 issue.
- `src/ir/` → `src/ir-backend/` + `src/ir-mid/` rename per #1131 §1.2. Deferred — cheap to do now, gets expensive later, but not blocking.
- Phase 3: monomorphization (#744), tagged unions (#745), escape analysis (#747), inline-small-functions-on-IR, constant folding.

## If this breaks later

The most likely regression vector is a **typeIdx signature mismatch** showing up as Wasm validation errors. That means the call-graph closure in `src/ir/select.ts` let something through. Start debugging there — is the closure pass iterating to fixpoint? Is there a callee I'm missing (e.g. an indirect call, a method call)?

The other likely regression is propagation going to `dynamic` unexpectedly. Run `buildTypeMap` in isolation against a failing source and inspect the TypeMap. If a function is `dynamic` when it should be a primitive, most often it's because body inference walks into a shape I didn't anticipate — extend `inferExpr` in `propagate.ts`.

## Handoff notes

Nothing in flight. Main is clean, merged, CI passed.

If another senior-dev picks up Phase 2.5 (multi-source wiring), the work is in `src/codegen/index.ts:generateMultiModule` — mirror the IR hook block from `generateModule`. The TypeMap needs to span all source files in the multi-compile, which means `buildTypeMap` needs a multi-source variant that walks every file's declarations into one name-indexed map.
