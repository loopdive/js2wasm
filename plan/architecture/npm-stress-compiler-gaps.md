---
title: "npm stress-test compiler gaps — cross-cutting index"
author: arch-npm-stress
date: 2026-04-11
baseline_commit: 07ac0224
related_issues: [1031, 1032, 1033, 1034, 1035, 1041, 1042, 1043]
---

# npm stress-test compiler gaps

Index and cross-cutting summary for the four Sprint 41 real-world stress tests. **Per-library assessments live directly in the issue files** — this doc covers only the gaps that affect multiple libraries and the overall recommendation.

## Per-library assessments

Each stress-test issue has an `## Architect Assessment (arch-npm-stress, 2026-04-11)` section with required features, current gaps vs compiler source, projected readiness per tier, top 3 blockers, and an implementation sketch:

- **[#1031 lodash](../issues/ready/1031.md#architect-assessment-arch-npm-stress-2026-04-11)** — pure compute. Tier 1 ~90% ready, Tier 4 (memoize/cloneDeep/debounce) ~10%. Closest clean win after #1041 pre-bundle lands.
- **[#1032 axios](../issues/ready/1032.md#architect-assessment-arch-npm-stress-2026-04-11)** — I/O. Blocked on both Node-builtin host-import routing and real async/await (#1042). Tier 4 real-GET not achievable until `await` is lowered.
- **[#1033 react](../issues/ready/1033.md#architect-assessment-arch-npm-stress-2026-04-11)** — closures + hooks. **Hooks verdict: YES**, the ref-cell closure path at `src/codegen/closures.ts:971-1131` is exactly what `useState` needs. Blocked on DOM host globals + #1043 DCE.
- **[#1034 prettier](../issues/ready/1034.md#architect-assessment-arch-npm-stress-2026-04-11)** — string-heavy pure compute. Cleanest test, strongest correctness signal (self-format byte-diff). Expect many small bugs on first run — that's the value.

## Cross-cutting compiler gaps

Capabilities that multiple stress tests depend on but don't exist yet in the compiler. Effort and blocking-set in priority order.

| # | Gap | Libraries blocked | Effort | Status |
|---|---|---|---|---|
| 1 | **Module graph resolution** (`preprocessImports` at src/import-resolver.ts:23 rewrites every import to `declare const X: any`) | all four | hard (workaround easy) | **#1041 filed** — pre-bundle with esbuild as scoped workaround |
| 2 | **`async`/`await` state-machine lowering** (`AwaitExpression` no-op at src/codegen/expressions.ts:790) | axios critical, react concurrent | research | **#1042 filed** — depends on #680 (Wasm-native generators) |
| 3 | **Node builtin host-import routing** (`node:http`, `node:stream`, `node:buffer`, ...) | axios | medium | Covered by **#1032** scope. Share mechanism with DOM globals. |
| 4 | **DOM host globals** (`document`, `window`, `HTMLElement`, `queueMicrotask`, `requestAnimationFrame`) | react | medium | Covered by **#1033** scope. Share mechanism with Node routing. |
| 5 | **`process.env.NODE_ENV` DCE** | react critical, prettier minor | easy | **#1043 filed** — pre-bundle alternative via esbuild `--define` |
| 6 | **`for...in` / `Object.keys` over WasmGC-opaque structs** | lodash Tier 3 | medium | Existing: **#853** |
| 7 | **Large-switch codegen scaling** (~200 cases in prettier printer-estree) | prettier Tier 4 | easy-medium | Profile first; file if slow or bloated |
| 8 | **Object-identity Map/WeakMap in standalone mode** | none for JS-host; prettier+react in WASI | hard | Defer to backlog; not a Sprint 41 blocker |

**Note on gaps 3 + 4**: Node builtin routing and DOM host globals share the same mechanism — recognize a specifier (module or global identifier), register it as an extern class with method signatures, emit externref imports per usage. Recommend designing them together as a single module-specifier-recognition hook in the import resolver, implemented twice.

## Recommendation: attempt prettier first

**#1034 prettier is the cleanest stress test to attempt first**, even before lodash, because:

1. **No host-boundary design question.** No DOM, no Node builtins, no network, no filesystem — pure compute on strings and objects.
2. **Self-format byte-diff is the strongest correctness signal we have.** Prettier is deterministic, so any character divergence from native prettier output is a concrete correctness bug with a trivial reproducer. Nothing in lodash/axios/react has an equivalent test.
3. **Every failure becomes a new harvestable issue.** Expect 10-30 small correctness bugs on the first self-format run — each is actionable.
4. **Unlocks a headline benchmark.** Compiled-prettier vs native-prettier on real source files = direct Wasm-vs-V8 perf number on a real workload.

**Runner-up: lodash Tier 1 + Tier 2** after #1041 (pre-bundle) lands. Quickest win — `lodash/clamp` is essentially a one-file smoke test for "real npm library running in Wasm."

**Defer axios and react** until the cross-cutting scaffolds (Node-builtin routing for axios, DOM globals + #1043 for react) exist.

## New issues filed

- **[#1041](../issues/ready/1041.md)** — Multi-file module graph compilation (start with pre-bundled single-file)
- **[#1042](../issues/ready/1042.md)** — async/await state-machine lowering (depends on #680)
- **[#1043](../issues/ready/1043.md)** — `process.env.NODE_ENV` compile-time substitution + DCE

All `sprint: Backlog`, all `ready`. Node + DOM host-import routing are not separately filed because they live inside #1032 and #1033 respectively as part of those issues' scope.

## Appendix: key source references for dev pickup

- **Module/imports**: src/import-resolver.ts:23 `preprocessImports`; src/compiler.ts:54; src/compiler/output.ts:311
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
