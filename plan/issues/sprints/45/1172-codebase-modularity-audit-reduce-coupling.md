---
id: 1172
title: "Codebase modularity audit — reduce coupling, improve layering, harden interfaces"
status: ready
created: 2026-04-25
updated: 2026-04-28
priority: high
feasibility: medium
reasoning_effort: max
task_type: refactor
area: architecture
language_feature: compiler-internals
goal: maintainability
---
# #1172 — Codebase modularity audit: reduce coupling, improve layering, harden interfaces

## Goal

Make the js2wasm compiler codebase more modular, easier to understand and maintain,
and more robust and professional — without changing observable compiler behaviour.

The compiler has grown organically across 45 sprints. Patterns that were expedient
early (barrel re-exports, God-object contexts, ad-hoc escape hatches, `as unknown as`
casts, copy-pasted helpers) now make the codebase harder to reason about, test in
isolation, and extend safely.

This issue tracks the architectural audit and the resulting actionable change set.
Each slice should be independently mergeable with no behaviour change.

## Scope

Audit the full `src/` tree for:

1. **Coupling / layering violations** — circular imports, upward dependencies,
   codegen calling into IR internals directly, etc.
2. **God objects** — `CodegenContext` carrying fields it doesn't need in every path;
   `WasmModule` as a mutable grab-bag.
3. **Duplicated helpers** — copy-pasted utilities across `codegen/`, `ir/`, `emit/`.
4. **Unsafe casts** — `as unknown as Instr` (158 occurrences), `as any`, implicit
   `any` from missing type annotations.
5. **Leaky abstraction boundaries** — callers reaching into implementation details
   of another module instead of using a defined interface.
6. **Dead / unreachable code** — exports that are never imported, branches gated on
   conditions that can never be false.
7. **Missing invariant enforcement** — places where a type annotation claims
   something is non-null but callers rely on runtime falsy checks as a safety net.
8. **File / module size** — files >1,000 LOC that are doing too many things and
   should be split.

## Deliverable from architect

An implementation plan that:
- Enumerates the top problems with concrete evidence (file, line range, coupling graph)
- Proposes a **prioritised slice sequence** — each slice independently mergeable
- For each slice: exact files changed, what moves/renames, what new interface is
  introduced, estimated diff size
- Flags any slice that could regress behaviour and explains the safeguard

## Acceptance criteria

1. Each slice passes `npm test -- tests/equivalence.test.ts` with no new failures
2. `npx tsc --noEmit` clean after each slice
3. No behaviour change — test262 pass rate does not regress
4. At least one of: coupling reduced (fewer cross-layer imports), unsafe casts
   eliminated, duplicated helpers consolidated, large files split

## Implementation Plan

> Audit performed against `main` @ 2b08eaaf9. Total compiler source is ~110k LOC of TypeScript across `src/` (excluding `runtime.ts`). All slices below are designed to be independently mergeable with no behaviour change. Each is verifiable via `npx tsc --noEmit` + `npm test -- tests/equivalence.test.ts`.

### Findings summary

| # | Problem | Evidence | Severity | Slice | Effort |
|---|---------|----------|----------|-------|--------|
| 1 | God object — `CodegenContext` has 120 fields covering 8 unrelated subsystems | `src/codegen/context/types.ts:202-445` | high | F + G | M+L |
| 2 | God function — `compileCallExpression` is ~5,800 lines | `src/codegen/expressions/calls.ts:493-6294` | high | I | L (deferred) |
| 3 | God module — `codegen/index.ts` (6,368 LOC) mixes driver + utility barrel | `src/codegen/index.ts`; 14 leaf modules import from it | high | A + B + H | S, S, M |
| 4 | Walk-instructions duplicated 4× | `class-bodies.ts:622-650`, `index.ts:2749-2770`, `index.ts:4023-4044`, `late-imports.ts:30-51` | high | C | S |
| 5 | 312 occurrences of `as unknown as Instr` for ops already in the union | distribution: 32× extern.convert_any, 19× unreachable, 18× i32.trunc_sat_f64_s, 17× call, 16× ref.cast_null, etc. | medium | D | S |
| 6 | Layering violation — `src/ir/integration.ts` imports from `src/codegen/` | `src/ir/integration.ts:27-28` | medium | E | S |
| 7 | Layering violation — `src/emit/wat.ts` imports from `src/codegen/walk-instructions.ts` | `src/emit/wat.ts:2` | low | C (rolled in) | S |
| 8 | Dead field — `FunctionContext.hoistedFuncs` declared but never assigned/read | `context/types.ts:144`, 0 other refs in src/ | low | J | S |
| 9 | 387 `as any` casts in core modules; many are walking instruction children | sample: `class-bodies.ts:630-645`, `walk-instructions.ts:28` | medium | C + D | S |
| 10 | 494 direct `ctx.mod.X.push(...)` calls — no barrier interface | grep `ctx\.mod\.\(types\|imports\|functions\|...\)\.push` | medium | K (deferred) | M |
| 11 | Cyclic dep workaround — `shared.ts` exists solely as a delegate registry | `src/codegen/shared.ts:1-20`, `registerCompileExpression`, etc. | low | (out of scope) | — |
| 12 | Three `shiftFuncIndices`-style passes that should be one | `index.ts:2749`, `index.ts:4023`, `late-imports.ts:19` | medium | C2 | S |

**High-value targets**: Slices C and D both touch hot code without risking behaviour change; together they remove ~250 unsafe casts and ~200 lines of duplicated walk logic.

---

### Slice sequence

#### Slice A — Move utility barrel out of `codegen/index.ts` (effort: S)

**Problem**: `src/codegen/index.ts` is 6,368 LOC. It contains both the driver (`generateModule`/`generateMultiModule` are the only symbols imported externally — by `src/compiler/output.ts:7`) **and** a barrel of utility helpers re-imported from 14 leaf modules: `resolveWasmType`, `addUnionImports`, `cacheStringLiterals`, `addStringImports`, `parseRegExpLiteral`, `getOrRegisterTupleType`, `ensureStructForType`, `hasAbstractModifier`, `hasStaticModifier`, `addIteratorImports`, `addArrayIteratorImports`, `addForInImports`, `STRING_METHODS`, `MATH_HOST_METHODS_*`, `KNOWN_CONSTRUCTORS`, `FUNCTIONAL_ARRAY_METHODS`. Every leaf-module import of `./index.js` pulls in the whole 6k-line driver.

**Change**:
- Create `src/codegen/registry/types-helpers.ts`. Move into it: `getOrRegisterTupleType`, `ensureStructForType`, `resolveWasmType`, `resolveNativeTypeAnnotation`, `isTupleType`, `getTupleElementTypes`, `tupleTypeKey`, `hasAbstractModifier`, `hasStaticModifier`, `cacheStringLiterals`, `parseRegExpLiteral`. These are stateless registry helpers.
- Create `src/codegen/registry/late-import-suites.ts`. Move into it: `addStringImports`, `addUnionImports`, `addIteratorImports`, `addArrayIteratorImports`, `addForInImports`, plus their `collect*Imports` helpers. They form a cohesive group: scan source → add late imports.
- Create `src/codegen/builtins-registry.ts`. Move the const tables: `STRING_METHODS`, `MATH_HOST_METHODS_1ARG`, `MATH_HOST_METHODS_2ARG`, `KNOWN_CONSTRUCTORS`, `FUNCTIONAL_ARRAY_METHODS`.
- Update the 14 leaf-module imports to import directly from the new files instead of from `./index.js`.
- Keep the re-exports in `codegen/index.ts` for one merge cycle (mark `@deprecated — import from registry/late-import-suites.ts directly`) so external consumers don't break.

**Files**:
- New: `src/codegen/registry/types-helpers.ts`, `src/codegen/registry/late-import-suites.ts`, `src/codegen/builtins-registry.ts`
- Modified: `src/codegen/index.ts` (delete moved sections, replace with re-exports)
- Modified: 14 importers (`array-methods.ts`, `binary-ops.ts`, `class-bodies.ts`, `closures.ts`, `declarations.ts`, `destructuring-params.ts`, `function-body.ts`, `literals.ts`, `object-ops.ts`, `property-access.ts`, `string-ops.ts`, `type-coercion.ts`, `typeof-delete.ts`, `expressions/calls.ts`)

**Safeguard**:
- Keep all symbols re-exported from `codegen/index.ts` for backward compat (no external API change)
- `tsc --noEmit` after each leaf-module migration
- Equivalence tests must remain green; this is mechanical movement, not logic change
- Diff size target: <300 lines net (some files lose imports, the new files gain content)

---

#### Slice B — Make `codegen/index.ts` driver-only (effort: S, depends on A)

**Problem**: After Slice A, `codegen/index.ts` still hosts internal helpers used only by the driver itself: `_emitStructFieldGettersInner` (line 579), `_emitVecAccessExportsInner` (line 1503), `emitClosureCallExport1` (line 1077), `buildNestedIfElse`, `buildGetterExtract`, `walkStmtForVars` (line 5832), `walkStmtForLetConst` (line 6062), the two `shiftFuncIndices` blocks (lines 2749, 4023). Driver flow is buried in 6k lines of helpers.

**Change**:
- Move the `emit*Export*` helpers (struct-field getters, vec accessors, closure call, to-primitive, iterator method, struct field names, dataview byte) into a new `src/codegen/emit-exports.ts`.
- Move `walkStmtForVars` / `walkStmtForLetConst` and the related hoist scanning helpers into `src/codegen/declarations-hoist-scan.ts`.
- Leave only the driver (`generateModule`, `generateMultiModule`, `addWasiStartExport`, the IR-path glue) plus the late-import shift logic in `index.ts`.
- After this slice, `index.ts` should be <2,500 LOC.

**Files**:
- New: `src/codegen/emit-exports.ts`, `src/codegen/declarations-hoist-scan.ts`
- Modified: `src/codegen/index.ts` (remove moved blocks)

**Safeguard**: Same as Slice A — pure code movement, keep re-exports.

---

#### Slice C — Consolidate instruction-tree walking (effort: S)

**Problem**: Four near-identical implementations of "recursively visit every Instr in a body, descending into `body`/`then`/`else`/`catches[].body`/`catchAll`":

1. `src/codegen/walk-instructions.ts:15-38` — canonical `walkInstructions` / `walkChildren` (already exists, but only `dead-elimination.ts` uses it).
2. `src/codegen/class-bodies.ts:624-647` — `scanInstrs` for ref.func collection.
3. `src/codegen/index.ts:2749-2770` — `shiftFuncIndices` (variant 1, in `addUnionImports`).
4. `src/codegen/index.ts:4023-4044` — `shiftFuncIndices` (variant 2, in `addStringImports`).
5. `src/codegen/expressions/late-imports.ts:31-51` — `shiftInstrs` (canonical late-import shifter, additionally handles `pendingInitBody` and `startFuncIdx`).

Plus inline `if (a.body && Array.isArray(...))` walks in `class-bodies.ts:630-645`. Each variant uses `instr as any` for child access because `Instr` union doesn't expose typed children accessors.

**Change**:
- **C1 (walker)**: All four duplicate walks → call `walkInstructions(body, visitor)`. Replace `class-bodies.ts:624-647`'s `scanInstrs` with a `walkInstructions(func.body, instr => { if (instr.op === "ref.func") refs.add(instr.funcIdx); })`. Move `walk-instructions.ts` → `src/ir/walk-instructions.ts` (it's a pure IR utility — fixes the `emit/wat.ts → codegen/` reverse-layering at `wat.ts:2`).
- **C2 (single shifter)**: Both `shiftFuncIndices` blocks in `index.ts` (lines 2749 and 4023) become thin wrappers around `shiftLateImportIndices` from `expressions/late-imports.ts`. The one differentiator — variant 2 also shifts `mod.startFuncIdx` and `pendingInitBody` — is already covered by `shiftLateImportIndices`. Diff: delete ~120 lines from `index.ts`.
- **C3 (typed children)**: Add an explicit typed helper `instrChildren(instr: Instr): readonly Instr[][]` in `walk-instructions.ts` that returns `[]` for leaf ops and `[then, else]`/`[body]`/`[body, ...catches.map(c=>c.body), catchAll]` for control-flow ops. Replace `walk-instructions.ts:28-37` (`const a = instr as any; if (a.body...)`) with a discriminated switch. Removes the last `as any` from the walker itself.

**Files**:
- New location: `src/ir/walk-instructions.ts` (moved from `src/codegen/`)
- Modified: `src/codegen/class-bodies.ts` (use walker; remove inline `scanInstrs`)
- Modified: `src/codegen/index.ts` (delete both `shiftFuncIndices` blocks; call `shiftLateImportIndices` instead)
- Modified: `src/codegen/dead-elimination.ts` (update import path)
- Modified: `src/emit/wat.ts` (update import path; now layered correctly: emit → ir, codegen → ir)
- Modified: `src/codegen/expressions/late-imports.ts` (use `walkInstructions` internally so all four variants share one impl)

**Safeguard**:
- Add a temporary unit test in `tests/walk-instructions.test.ts` that exercises every Instr op with children (`block`, `loop`, `if/then/else`, `try/catch/catchAll`) and asserts `walkInstructions` visits every node exactly once.
- Equivalence tests must stay green — `shiftFuncIndices` consolidation has caused regressions before (#1109), so verify the late-import shift integration tests pass: `npm test -- tests/late-imports.test.ts` if present.

---

#### Slice D — Eliminate cargo-cult `as unknown as Instr` casts (effort: S)

**Problem**: 312 occurrences of `as unknown as Instr` plus 75 of `as Instr` (387 total). Distribution shows the same ops repeatedly cast: `extern.convert_any` ×32, `unreachable` ×19, `i32.trunc_sat_f64_s` ×18, `call` ×17, `ref.cast_null` ×16, `local.set` ×15, `i64.const` ×15, `ref.test` ×14, `ref.cast` ×13, `local.get` ×13, etc. **All of these ops are already in the `Instr` union** (`src/ir/types.ts:117-360`). Inspection of `src/codegen/array-methods.ts:454-457` shows the cast is unnecessary — line 457's `{ op: "ref.null.extern" }` has no cast and compiles fine. The casts are cargo-cult patterns from a time when the union was incomplete.

**Change**: Mechanical removal in three batches:
- **D1**: Strip `as unknown as Instr` from `fctx.body.push({ op: "..." })` and `fctx.body.push({ op: "...", index: x })` literal pushes where the op is in the InstrBase union. Verify with `tsc --noEmit` after each file.
- **D2**: Strip `as unknown as Instr` from array-literal expressions like `[{ op: "..." }] as unknown as Instr[]` → just `[{ op: "..." }]`.
- **D3**: For the genuinely problematic remainder (e.g. dynamic-keyed objects, ones built piecewise), replace `as unknown as Instr` with `satisfies Instr` where possible — gives the same compile-time check without disabling type narrowing.

**Files** (largest concentrations):
- `src/codegen/array-methods.ts` (~180 casts)
- `src/codegen/native-strings.ts`, `src/codegen/string-ops.ts`, `src/codegen/type-coercion.ts`, `src/codegen/object-ops.ts`, `src/codegen/class-bodies.ts`, `src/codegen/binary-ops.ts`, `src/codegen/property-access.ts`
- `src/ir/lower.ts` (3 casts at lines 270, 274, 529)

**Safeguard**:
- Per-file: `tsc --noEmit` (proves the casts were unnecessary)
- `npm test -- tests/equivalence.test.ts` (proves no behaviour change — the cast was a no-op at runtime)
- One file per commit to keep diffs reviewable. Total of ~10 commits, each <50 lines diff.

**Edge case**: A handful of casts (`array-methods.ts:820, 822, 924, 926` etc.) cast inside conditional `[expr1, expr2]` arrays where TS widens the element type. For these, prefer `satisfies Instr` on the literal or hoist into a typed variable rather than dropping the cast outright.

---

#### Slice E — Fix `ir/` → `codegen/` reverse-layering (effort: S)

**Problem**: `src/ir/integration.ts` (the only file in `src/ir/` that depends on codegen) imports `addFuncType` from `../codegen/registry/types.js` and `CodegenContext` from `../codegen/context/types.js`. The IR layer is supposed to be lower than codegen — codegen consumes IR, not the other way around. This forces every consumer of `src/ir/` to also pull in codegen.

**Change**: There are two options; recommend (a):
- **(a) Move `integration.ts` out of `src/ir/`** — it's not really IR machinery, it's the IR/codegen *bridge*. Move it to `src/codegen/ir-bridge.ts`. Update the single caller `src/codegen/index.ts:16`.
- (b) Invert the dependency: pass the type-registry interface and context into integration as parameters. Higher friction, ~50 lines of new wiring.

**Files**:
- Move: `src/ir/integration.ts` → `src/codegen/ir-bridge.ts`
- Modified: `src/codegen/index.ts` (update import path)
- Verify nothing else imports from `src/ir/integration.js` (only test files might): `grep -rn "ir/integration" src/ tests/`

**Safeguard**: TypeScript will error if any `import` path is missed. Equivalence test verifies behaviour.

---

#### Slice F — Carve `WasiContext` out of `CodegenContext` (effort: S)

**Problem**: `CodegenContext` has 6 WASI-specific fields (`wasi`, `wasiFdWriteIdx`, `wasiProcExitIdx`, `wasiPathOpenIdx`, `wasiFdCloseIdx`, `wasiBumpPtrGlobalIdx`, `wasiNodeFsFuncs`) that are only used when `target: "wasi"`. They sit alongside 100+ unrelated fields, making the context shape opaque.

**Change**:
- Define `interface WasiContext { fdWriteIdx: number; procExitIdx: number; pathOpenIdx: number; fdCloseIdx: number; bumpPtrGlobalIdx: number; nodeFsFuncs: Set<string>; }` in `src/codegen/context/types.ts`.
- Replace the 6 fields with a single `wasi: WasiContext | null` field. `null` means non-WASI build.
- `createCodegenContext` initialises `wasi: options?.wasi ? { fdWriteIdx: -1, ... } : null`.
- All callers do `if (ctx.wasi) { ctx.wasi.fdWriteIdx = ... }`.

**Files**:
- `src/codegen/context/types.ts` (interface change)
- `src/codegen/context/create-context.ts` (init)
- 14 call-sites of `ctx.wasi*` (use `grep -rn "ctx\.wasi"`)

**Safeguard**: TS narrows `ctx.wasi` to non-null inside the guard, eliminating "did I forget to check WASI?" bugs that the current `wasi: boolean` flag couldn't catch.

---

#### Slice G — Carve `NativeStringContext` out of `CodegenContext` (effort: S)

**Problem**: 7 native-string fields scattered through `CodegenContext`: `nativeStrings`, `nativeStrDataTypeIdx`, `anyStrTypeIdx`, `nativeStrTypeIdx`, `consStrTypeIdx`, `nativeStrHelpersEmitted`, `nativeStrExternBridgeEmitted`, `nativeStrHelpers`. Same pattern as F: cohesive subsystem awkwardly inlined into the God context.

**Change**: Mirror Slice F. Introduce `interface NativeStringContext { dataTypeIdx: number; anyStrTypeIdx: number; strTypeIdx: number; consStrTypeIdx: number; helpersEmitted: boolean; externBridgeEmitted: boolean; helpers: Map<string, number>; }`. Single field `nativeStrings: NativeStringContext | null`.

Same scaffolding, same migration. `nativeStrings: boolean` becomes `nativeStrings !== null`.

**Files**:
- `src/codegen/context/types.ts`, `create-context.ts`, `src/codegen/native-strings.ts`, plus 8 callers found via `grep -rn "ctx\.\(nativeStr\|anyStrTypeIdx\|consStrTypeIdx\)"`.

**Safeguard**: Per-file tsc check, equivalence tests.

---

#### Slice H — Move `_emitStructFieldGettersInner` etc. behind seams (effort: S)

**Problem**: `src/codegen/index.ts` defines `function _emitStructFieldGettersInner` (line 579), `function _emitVecAccessExportsInner` (line 1503). These are internal helpers (underscore prefix) that aren't exported but live in the 6k-line driver file. They each implement a complete export-emit subsystem (50–200 lines).

**Change**: Move them to `src/codegen/emit-exports.ts` (created in Slice B). Leave the public callers (`emitStructFieldGetters`, `emitVecAccessExports`) where they are; they become thin wrappers around the moved internal functions.

**Files**: rolled into Slice B.

---

#### Slice J — Delete dead `FunctionContext.hoistedFuncs` field (effort: S)

**Problem**: `src/codegen/context/types.ts:144` declares `hoistedFuncs?: Set<string>;`. `grep -rn "hoistedFuncs" src/` shows zero other references. Field is never assigned, never read.

**Change**: Delete the field and its JSDoc. One-line diff.

**Files**: `src/codegen/context/types.ts`

**Safeguard**: `tsc --noEmit` proves nothing references it.

---

### Deferred (out of scope for this sprint)

These are real problems but each is too large or too risky to attack in a single refactor sprint without dedicated test coverage work first.

#### Slice I — Decompose `compileCallExpression` (deferred, effort: XL)

`src/codegen/expressions/calls.ts:493-6294` is one function (~5,800 lines). It's a giant `if`-cascade dispatching on call shape: optional chain, RegExp, eval, dynamic-import, super.method, property-access call, isNaN/isFinite/parseInt/parseFloat, regular call, IIFE, super(), comma-indirect, element-access call, fn.bind().call(), CallExpression callee, ConditionalExpression callee. Each branch is 50–500 lines of inline logic mixing argument compilation, late-import registration, body emission.

**Why deferred**: Each branch is genuinely entangled with the surrounding fctx.body state via late-import shifts and stack-balance assumptions. A naïve extraction would either reintroduce cycles or hide important ordering invariants. Needs a dedicated sprint with property-style tests for each call shape.

**Sketch for future**: Each branch becomes a `tryCompile<Shape>Call(ctx, fctx, expr): InnerResult | undefined` function in its own file under `src/codegen/expressions/call-shapes/`. The dispatcher is a list of predicates that decides which shape applies, then calls it. Order of predicates is preserved exactly to maintain semantics.

#### Slice K — Module-mutation barrier (deferred, effort: M)

494 direct `ctx.mod.X.push(...)` calls allow any leaf module to corrupt global state (duplicate type indices, exports out of sync with funcMap, etc.). A future refactor should introduce `ModuleBuilder` with methods `addType`, `addFunction`, `addExport` that maintain invariants. **Why deferred**: low priority compared to A–G; the existing `registry/` module already covers the dangerous cases (types, imports, string constants). The remaining .push() calls are routine.

#### Slice L — Remove the `shared.ts` delegate registry (deferred, effort: M)

`src/codegen/shared.ts` exists solely because `expressions.ts` and `closures.ts` and `index.ts` form a dependency cycle. Each registers its real implementation at module-load time (`registerCompileExpression`, etc.). After Slice A reduces `index.ts`, the cycle may be naturally broken; revisit then. **Why deferred**: depends on A and B landing first to see the new shape.

#### Other concerns surfaced but not actioned

- **387 `as any` casts** — most are walking ts.Node fields where TS lib has an outdated declaration. Hard to fix mechanically without running into TS-version variance.
- **193 fields total across `CodegenContext` + `FunctionContext`** — Slices F and G shrink it modestly. Real fix is tracking which fields are subsystem-specific and migrating each subsystem to its own context (analytics, IR-path state, regex state, etc.). Future sprint.
- **`ir/` and `codegen-linear/` divergence** — `codegen-linear/index.ts` is 4,813 LOC and likely has its own copies of patterns being cleaned up here. Not in scope; treat after `gc` codegen is cleaner.

---

### Recommended merge order

1. **J** (dead field — trivial warm-up, validates the workflow)
2. **D1** (one file at a time, easy review, large win)
3. **C1** (use existing walker; mechanical)
4. **A** (move utility barrel — sets up B, H)
5. **C2** (consolidate `shiftFuncIndices` — depends on A landing first)
6. **E** (move `integration.ts` — independent)
7. **B + H** (slim driver — depends on A)
8. **D2 + D3** (continue cast cleanup)
9. **F** (WasiContext)
10. **G** (NativeStringContext)
11. **C3** (typed `instrChildren`)

Total estimated diff: ~2,500 lines moved/deleted, ~600 lines net reduction. No behaviour change.
