# dev-g context summary — Sprint 45 wrap

## Task
Issue #907 — Replace `__init_done` runtime guards with start/init entry semantics.

## Outcome
Merged via PR #25 with net +59 on test262.

## What was implemented
For non-WASI modules without `main()` that have top-level statements, wire `__module_init` into the Wasm `start` section so init runs automatically once during instantiation. Replaces both legacy mechanisms in one path:

- the `__init_done` global + per-export guard preambles (the "exports + top-level" path), and
- the `_start` export wrapper (the "module-init-only" path).

WASI is unaffected: `addWasiStartExport` continues to wrap `__module_init` in a `_start` export; `startFuncIdx` is intentionally NOT set in WASI mode (otherwise init would run twice).

## Files touched
- `src/ir/types.ts` — added `startFuncIdx?: number` to `WasmModule`.
- `src/emit/binary.ts` — emit Wasm start section (id 8) between Export and Element.
- `src/emit/wat.ts` — emit `(start <idx>)` after exports.
- `src/codegen/declarations.ts` — collapse two-strategy "no main" branch into one path.
- `src/codegen/dead-elimination.ts` — mark `startFuncIdx` as a function root, remap after renumber.
- `src/codegen/index.ts` (`addUnionImports`) — shift `startFuncIdx` alongside `declaredFuncRefs` / element-segments / call instructions.
- `playground/main.ts` — drop synthesized-`main()` and explicit `_start()` paths.
- `tests/issue-907.test.ts` — 8 regression tests.

## Bug found and fixed during implementation
`addUnionImports` was the only place in the compiler that didn't shift `startFuncIdx`. Without that fix, modules with closures (which trigger `emitClosureCallExport` → late union imports) emitted `(start 0)` pointing at the wrong function and tripped `WebAssembly.validate()`. This was caught by failing equivalence tests (`function-name-length.test.ts`, `illegal-cast-assert-throws.test.ts`) before pushing.

## Patterns to remember
- **Wasm `start` section does NOT add a function** — it's a 4-byte section pointing at an existing function index. Function counts don't change.
- Any place that shifts function indices in the IR must also shift `startFuncIdx`. Currently three places: `addUnionImports`, `eliminateDeadImports`, and the start-section reference itself.
- The dead-elimination `fR` map covers BOTH imports AND defined functions (it iterates `0 .. numImpF + functions.length`). So `fR.has(startFuncIdx)` correctly handles defined-function index shifts caused by dead import removal.
- For test262 wrapTest output (top-level preamble + `export function test()`), my change produces a 14-byte smaller binary by removing one guard preamble + one `global.set $__init_done`. Function count unchanged: 13 = 13.

## Diagnostic process for the regression-gate scare
PR #25 first CI run showed 315 regressions (vs baseline 7h+ stale). The cluster looked alarming — TypedArray:121, Object:27, Promise:21, etc. Three index-shift hypotheses were proposed by team-lead and disproved with empirical evidence:

1. **Index shift from start function insertion** — disproved by direct comparison: function count is 13 on both main and branch on test262 wrap pattern.
2. **Dead-elimination `fR` not covering defined functions** — disproved by reading the loop: `for o = 0..numImpF + mod.functions.length`.
3. **Eager-vs-lazy init throws at instantiation** — disproved by production-bundle probe: 0/14 wasm_compile regressions throw at instantiate on EITHER main or branch.

84 regressions sampled across all categories using both source compiler and production bundle, on BOTH main and branch. Result: 0 attributable to my change. The CI failure was 100% baseline drift (the 7h stale baseline predated PRs #22-24).

The dominant CI error was `Codegen error: %Array%.from requires that the property of the first argu...` (V8 runtime TypeError fired from inside the compile pipeline's TypeScript checker, exposed by PR #23's wrapper-object work in `src/codegen/binary-ops.ts`). Not related to start sections.

## Lesson for future regression-gate failures
When a regression-gate fails with `regressions ≈ improvements` in mirror-image categories AND the baseline is more than ~3h old AND multiple PRs have merged in that window, **first action: refresh baseline, retrigger CI**. Do not spend time investigating until the baseline is fresh. The mirror-image categorical signature is the textbook drift fingerprint.

Empirical sampling protocol that worked here:
1. Pick a handful of "regressed" tests across the dominant buckets.
2. Compile + instantiate + run them locally on the PR branch.
3. Run the SAME tests on main (no PR changes).
4. Compare: identical results = drift, divergent results = real bug.
5. Use the **production bundle** (compiler-bundle.mjs + runtime-bundle.mjs) to match the CI code path exactly, not just `npx tsx src/...`.

## Work suspended / known issues to follow
None. PR #25 merged cleanly with +59 net. No follow-up issue needed.
