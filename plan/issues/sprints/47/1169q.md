---
id: 1169q
title: "IR Phase 4 Slice 14 — retire legacy codegen: delete expressions.ts, statements.ts, repair passes"
status: done
created: 2026-05-01
updated: 2026-05-01
completed: 2026-05-02
priority: high
feasibility: medium
reasoning_effort: medium
task_type: refactor
area: ir
language_feature: n/a
goal: maintainability
depends_on: [1169n, 1169o, 1169p]
es_edition: n/a
related: [1169]
---
# #1169q — IR Phase 4 Slice 14: retire legacy codegen

## Problem

After slices 11–13 land, `planIrCompilation` should claim 95%+ of functions in
the test262 corpus. The legacy path (`src/codegen/expressions.ts`,
`statements.ts`, `type-coercion.ts`, `fixups.ts`, `stack-balance.ts`) can be
retired, and the repair passes that exist because legacy emission is error-prone
can be removed or gated to no-op.

This is the final step of IR Phase 4.

## Acceptance criteria

1. Add assertion in `planIrCompilation`: if any function falls through to
   legacy, log it and (in test mode) throw. Validate against test262 corpus
   — 0 fallbacks expected after slices 11–13 land.
2. Delete `src/codegen/expressions.ts` and `src/codegen/statements.ts` (or
   reduce to thin shims with a single `throw new Error("legacy path retired")`)
3. Remove `stackBalance` pass from `src/codegen/stack-balance.ts` (or no-op it)
4. Remove `fixupStructNewArgCounts` and `fixupStructNewResultCoercion` from
   `src/codegen/fixups.ts`
5. `src/codegen/integration.ts` no longer branches on `planIrCompilation` result
   — all functions go through IR
6. All equivalence tests pass; test262 pass rate does not regress

## Implementation notes

- Do NOT delete files until the fallback assertion passes cleanly on the full
  test262 corpus. Any remaining fallbacks are either bugs in slices 11–13 or
  genuine deferred features (`eval`, dynamic import, `with` — these are
  permanently excluded and should throw at selector time, not fall through).
- `peepholeOptimize` — review which peephole passes are still needed post-IR;
  the IR lowerer emits cleaner code so some passes may become no-ops.
- The `type-coercion.ts` module is used by the IR lowerer itself (for
  `externref` boxing helpers) — keep it, just remove the legacy dispatch.

## Out of scope

- Permanently deferred features: `eval`, `with`, dynamic `import()`,
  `SharedArrayBuffer`, `Proxy`. These stay on a "legacy stub" path that
  throws `CompileError` with a clear message.

## Sprint 47 outcome — Step 1 done, Steps 2–5 deferred

**Step 1 (telemetry) landed in PR #141** (`0ed3df838a85`). Corpus measurement on
500 test262 files revealed **0% IR claim rate** (2377/2377 functions fall back).

Root cause: the IR selector requires resolvable param/return types. Test262 is
untyped JS; its harness helpers (`assert_*`, `isSameValue`) use `any` params and
`void` returns — both currently rejected by `isPhase1Expr`.

Rejection breakdown:
- `return-type-not-resolvable` (void): 68.1% — harness wrapper functions
- `param-type-not-resolvable` (any): 15.9% — untyped harness helpers
- `body-shape-rejected`: 15.9% — actual test bodies (what slices 11–13 target)

**Deletion (Steps 2–5) deferred** until selector widening brings claim rate >80%.
Two follow-up issues needed (backlog):
- **selector: accept `any` params → lower as externref** (~84% claim after `void` fix)
- **selector: accept `void` return type** (~16% → ~84% combined with above)

The telemetry infrastructure (PR #141) remains and will drive all future
measurements. Steps 2–5 are not removed — they are unchanged implementation spec
for when the claim rate is ready.
