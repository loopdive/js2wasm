---
title: "npm stress-test compiler gaps — cross-cutting index"
author: arch-npm-stress
date: 2026-04-11
baseline_commit: 07ac0224
related_issues: [1031, 1032, 1033, 1034, 1035, 1042, 1043, 1044, 1045, 1046]
---

## 2026-04-11 correction

**Earlier versions of this doc and the four per-library Architect Assessments claimed the compiler has no module graph resolver and all stress tests need a pre-bundle scaffold (#1041).** That framing was wrong.

The compiler already has full multi-file compilation via `compileProject` (`src/index.ts:216`), which uses `ModuleResolver` (`src/resolve.ts:27`, backed by `ts.resolveModuleName` + Node fs) and `resolveAllImports` (`src/resolve.ts:204`) to walk the transitive import closure, then hands every reachable file to `compileMultiSource` (`src/compiler.ts:406`) for one shared `ts.Program`. `preprocessImports` is only the single-file `compile()` fallback; it is NOT on the multi-file path. Existing tests: `tests/resolve.test.ts`, `tests/multi-file.test.ts`, `tests/equivalence/multi-file-compilation.test.ts`. Live use: `playground/main.ts:1879`.

**Consequences:**
- **#1041 closed** (moved to `plan/issues/wont-fix/1041.md`)
- **#1046 filed** in Backlog as the real research issue: *separate ES-module compilation with consumer-driven import/export type specialization* — per-module Wasm artifacts that can be distributed and linked, with an optional specialization protocol analogous to Rust monomorphization / C++ template instantiation
- **#1031 (lodash)** and **#1034 (prettier)** unblocked immediately — run them today via `compileProject`
- **#1032 (axios)** and **#1033 (react)** still depend on host-import routing (**#1044** Node, **#1045** DOM) and `#1043` NODE_ENV DCE, but no longer on a module-graph scaffold
- **Recommendation: attempt prettier first** via `compileProject node_modules/prettier/index.js`, then lodash.

# npm stress-test compiler gaps

Index and cross-cutting summary for the four Sprint 41 real-world stress tests. **Per-library assessments live directly in the issue files** — this doc covers only the gaps that affect multiple libraries and the overall recommendation.

## Per-library assessments

Each stress-test issue has an `## Architect Assessment (arch-npm-stress, 2026-04-11)` section with required features, current gaps vs compiler source, projected readiness per tier, top 3 blockers, and an implementation sketch:

- **[#1031 lodash](../issues/ready/1031.md#architect-assessment-arch-npm-stress-2026-04-11)** — pure compute. Tier 1 ~90% ready, Tier 4 (memoize/cloneDeep/debounce) ~10%. Runnable today via `compileProject node_modules/lodash/clamp.js`; no precondition work.
- **[#1032 axios](../issues/ready/1032.md#architect-assessment-arch-npm-stress-2026-04-11)** — I/O. Blocked on both Node-builtin host-import routing and real async/await (#1042). Tier 4 real-GET not achievable until `await` is lowered.
- **[#1033 react](../issues/ready/1033.md#architect-assessment-arch-npm-stress-2026-04-11)** — closures + hooks. **Hooks verdict: YES**, the ref-cell closure path at `src/codegen/closures.ts:971-1131` is exactly what `useState` needs. Blocked on DOM host globals + #1043 DCE.
- **[#1034 prettier](../issues/ready/1034.md#architect-assessment-arch-npm-stress-2026-04-11)** — string-heavy pure compute. Cleanest test, strongest correctness signal (self-format byte-diff). Expect many small bugs on first run — that's the value.

## Cross-cutting compiler gaps

Capabilities that multiple stress tests depend on but don't exist yet in the compiler. Effort and blocking-set in priority order.

| # | Gap | Libraries blocked | Effort | Status |
|---|---|---|---|---|
| 1 | ~~Module graph resolution~~ **Already exists via `compileProject`**. Separate-compilation + consumer-driven type specialization is the real research issue | none for #1031/#1034; distribution/optimization for future work | hard (research) | **#1041 closed**, **#1046 filed** (Backlog) |
| 2 | **`async`/`await` state-machine lowering** (`AwaitExpression` no-op at src/codegen/expressions.ts:790) | axios critical, react concurrent | research | **#1042 filed** — depends on #680 (Wasm-native generators) |
| 3 | **Node builtin host-import routing** (`node:http`, `node:stream`, `node:buffer`, ...) | axios | medium | Covered by **#1032** scope. Share mechanism with DOM globals. |
| 4 | **DOM host globals** (`document`, `window`, `HTMLElement`, `queueMicrotask`, `requestAnimationFrame`) | react | medium | Covered by **#1033** scope. Share mechanism with Node routing. |
| 5 | **`process.env.NODE_ENV` DCE** | react critical, prettier minor | easy | **#1043 filed** — pre-bundle alternative via esbuild `--define` |
| 6 | **`for...in` / `Object.keys` over WasmGC-opaque structs** | lodash Tier 3 | medium | Existing: **#853** |
| 7 | **Large-switch codegen scaling** (~200 cases in prettier printer-estree) | prettier Tier 4 | easy-medium | Profile first; file if slow or bloated |
| 8 | **Object-identity Map/WeakMap in standalone mode** | none for JS-host; prettier+react in WASI | hard | Defer to backlog; not a Sprint 41 blocker |

**Note on gaps 3 + 4**: Node builtin routing and DOM host globals share the same mechanism — recognize a specifier (module or global identifier), register it as an extern class with method signatures, emit externref imports per usage. Recommend designing them together as a single module-specifier-recognition hook in the import resolver, implemented twice.

## Leverage TypeScript type information across all four stress tests

None of the four libraries need hand-written signatures for the compiler:

| Library   | Source  | Types                                | Install                         |
| --------- | ------- | ------------------------------------ | ------------------------------- |
| lodash    | `.js`   | `@types/lodash` (sidecar)            | `pnpm add -D @types/lodash`     |
| axios     | `.js`   | **bundled** `index.d.ts`             | (nothing extra)                 |
| prettier  | `.js`   | **bundled** `index.d.ts`             | (nothing extra)                 |
| react     | `.js`   | `@types/react` + `@types/react-dom`  | `pnpm add -D @types/react @types/react-dom` |

**How it plugs in**:

1. The compiler already supports **`allowJs: true` + `checkJs: true`** (`src/compiler.ts:57-87`, `src/checker/index.ts:276-309`). This is what lets the `ts.Program` accept `.js` sources and still type-check them against paired declaration files.
2. `ModuleResolver` delegates to **`ts.resolveModuleName`** (`src/resolve.ts:144`), which already honors Node10 resolution rules: package `"types"` / `"typings"` fields, sidecar `@types/*` in `typeRoots`, `package.json` `exports` map, bundled `.d.ts` next to `.js`.
3. `ts.Program` inside `compileMultiSource` (via `analyzeMultiSource`) builds a real `ts.TypeChecker` over the full multi-file input with `allowJs: true` — the checker sees precise signatures from `.d.ts` files even for `.js` implementations.
4. For host-import modules (Node builtins in **#1044**, DOM globals in **#1045**), use **`@types/node`** and the default **`lib.dom.d.ts`** (already loaded by TypeScript) as the source of truth for extern-class method signatures. The extern-class registration path at `src/codegen/index.ts:2661,:4100` should read from these declaration files instead of hand-writing method lists.

**Implication**: the compiler does not need a new type-extraction layer for the stress tests. What each stress test should verify is whether the current `allowJs` + `checkJs` + `ModuleResolver` combination *actually* surfaces declaration-sourced signatures on the multi-file path. If `compileProject` drops them (e.g., the BFS walker in `resolveAllImports` only queues `.ts`/`.tsx`/`.d.ts` and not `.js`, see `src/resolve.ts:39`), file that as a concrete precondition issue — this is the most likely real gap and is trivially fixable.

**Proposed follow-up (likely needed)**: small compiler PR to ensure that when `ts.resolveModuleName` resolves a bare specifier to a bundled or sidecar `.d.ts`, `resolveAllImports` ALSO queues the corresponding `.js` implementation file (discovered via the `packageId` or by replacing the extension). Otherwise the `.d.ts` gives us types but the `.js` bodies never enter the `ts.Program`. File this as a new issue (TBD number — **#1047 is taken by the harvester's private-class-elements issue**, do not reuse) once a stress-test run confirms the gap.

## Recommendation: attempt prettier first

**#1034 prettier is the cleanest stress test to attempt first**, even before lodash, because:

1. **No host-boundary design question.** No DOM, no Node builtins, no network, no filesystem — pure compute on strings and objects.
2. **Self-format byte-diff is the strongest correctness signal we have.** Prettier is deterministic, so any character divergence from native prettier output is a concrete correctness bug with a trivial reproducer. Nothing in lodash/axios/react has an equivalent test.
3. **Every failure becomes a new harvestable issue.** Expect 10-30 small correctness bugs on the first self-format run — each is actionable.
4. **Unlocks a headline benchmark.** Compiled-prettier vs native-prettier on real source files = direct Wasm-vs-V8 perf number on a real workload.

**Runner-up: lodash Tier 1 + Tier 2** — runnable today via `compileProject`. `lodash/clamp` is essentially a one-file smoke test for "real npm library running in Wasm."

**Defer axios and react** until the cross-cutting scaffolds (Node-builtin routing for axios, DOM globals + #1043 for react) exist.

## New issues filed

- **[#1042](../issues/ready/1042.md)** — async/await state-machine lowering (depends on #680, Backlog)
- **[#1043](../issues/ready/1043.md)** — `process.env.NODE_ENV` compile-time substitution + DCE (Sprint-41)
- **[#1044](../issues/ready/1044.md)** — Node builtin modules as host imports (Sprint-41)
- **[#1045](../issues/ready/1045.md)** — DOM globals as extern classes (Sprint-41)
- **[#1046](../issues/backlog/1046.md)** — Separate ES-module compilation with consumer-driven type specialization (Backlog, research)
- ~~[#1041]~~ — Closed as framing error, see `plan/issues/wont-fix/1041.md`

## Appendix: key source references for dev pickup

- **Module graph (multi-file, real path)**: src/resolve.ts:27 `ModuleResolver`, src/resolve.ts:204 `resolveAllImports`, src/index.ts:216 `compileProject`, src/compiler.ts:406 `compileMultiSource`
- **Single-file fallback only**: src/import-resolver.ts:23 `preprocessImports` (NOT on the multi-file path)
- **AwaitExpression no-op**: src/codegen/expressions.ts:790
- **Closure ref cells (useState enabler)**: src/codegen/closures.ts:971-1131
- **Try/catch exceptions**: src/codegen/statements/exceptions.ts:124-293
- **Symbol.iterator sidecar**: src/runtime.ts:380-403, :1009, :1990-2026
- **Symbol.for**: src/runtime.ts:1618
- **WeakMap/WeakSet/WeakRef extern classes**: src/runtime.ts:818-820
- **Map/Set extern class registration**: src/codegen/index.ts:2661, :4100
- **Object.defineProperty sidecar accessors**: src/runtime.ts:1323-1446
- **Object.freeze/seal WeakSets**: src/runtime.ts:38-42
- **String methods**: src/codegen/string-ops.ts
- **Array methods (long tail, after #1022/#1030/#1040)**: src/codegen/array-methods.ts
- **Shape inference / recursive type widening**: src/shape-inference.ts
- **Tree-shaking / DCE**: src/treeshake.ts, src/codegen/dead-elimination.ts
