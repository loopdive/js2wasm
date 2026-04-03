# Sprint 35 — Push Toward 43%

**Date**: 2026-04-03
**Goal**: Push toward 43% — medium-difficulty high-impact runtime fixes
**Baseline**: 17,583 pass / 43,120 official (40.8%) — post sprint-33

## Context

After sprints 31/35 (CE reduction + incremental fixes) and 33 (benchmark recovery), this sprint targets the medium-difficulty runtime failures that don't require full architectural features.

## Task queue

Issues already completed in sprint 35 are removed. Remaining:

| Order | Issue | Impact | Notes |
|-------|-------|--------|-------|
| 1 | #858 | 182 FAIL | Worker/timeout exits + eval null deref |
| 2 | #863 | 70 FAIL | decodeURI/encodeURI missing |
| 3 | #845 | 340 CE | Misc CE: object literals, RegExp, for-in/of edges (needs architect) |
| 4 | #855 | 210 FAIL | Promise/async error handling |
| 5 | #853 | 58 FAIL | Opaque Wasm objects in for-in/Object.create |
| 6 | #849 | 200 FAIL | Mapped arguments object sync (needs architect) |
| 7 | #822 WI4 | 17 CE | struct.new type stack inference (deferred from s31) |
| 8 | #924 | infra | Vite dev server 9GB OOM — playground unusable locally |
| 9 | #925 | presentation | Landing page: conformance circle + ES edition timeline diagrams |

### Already done (removed from queue)
- ~~#856~~ — done in sprint 35 (ValidateAndApplyPropertyDescriptor)
- ~~#844~~ — done (prior session)
- ~~#831~~ — done in sprint 35 (negative test early error detection)
- ~~#840~~ — done in sprint 35 (array 0-arg)
- ~~#829~~ — done (prior session)

### Stretch / architectural (not in this sprint)
- #797 — Property descriptor subsystem (~5,000 FAIL) — needs full architect spec
- #799 — Prototype chain (~2,500 FAIL) — needs full architect spec
- #831 remaining — yield-as-id, await-as-id patterns (159/242 done, 83 remain)

## Dev paths

**Dev-1**: #858 → #863 → #853 (runtime error fixes)
**Dev-2**: #845 (needs architect first) → #855 → #849

## Expected impact

| Issue | Est. tests fixed |
|-------|-----------------|
| #858 | ~100 |
| #863 | ~50 |
| #845 | ~200 |
| #855 | ~100 |
| #853 | ~40 |
| #849 | ~100 |
| **Total** | **~590** |

## Results

**Baseline**: 17,583 pass / 43,120 official (40.8%)
**Final**: 17,717 pass / 43,120 official (41.1%) — pending #831 v2 merge

| Issue | Pre-merge | Post-merge | Delta | Status |
|-------|-----------|------------|-------|--------|
| #858 + #863 | 17,583 | 17,782 | +199 | merged (globalThis + URI encoding) |
| #853 | 17,782 | 17,782 | +0 (runtime fix) | merged (opaque object enumeration) |
| #855 | 17,583 | 17,717 | +134 | merged (Promise resolution + async) |
| #845 | — | — | — | already fixed by prior work |
| #849 | — | — | — | already fixed by prior work |
| #822 WI4 | — | — | — | already fixed by prior work |
| #924 | — | — | infra | merged (Vite OOM → 84MB) |
| #925 | — | — | frontend | merged (chart web components) |
| #831 v2 | 17,717 | pending | ~+150 est. | tester running |

**Additional work completed:**
- #926-#931: PO error pattern analysis, 6 new issues created
- #932: Issue for feature coverage % on landing page
- #933: Issue for shared chart web components
- #934: Issue for array benchmark f64 conversion churn
- Landing page: mission subtitle, donut chart, ES edition bars, typewriter fix
- Vite watcher: excluded worktrees to prevent delayed OOM
- Compiler: top-level await for Node builtins, removed eval("require")
- Report data: fixed dangling symlink, added public/ symlinks

## Retrospective

### What went well
- **Merge protocol followed** — testers spawned for #855 and #831, with full test262 runs. Caught the #855 baseline comparison mistake before bad data hit main.
- **5 devs in parallel** at peak — #855, #845, #849, #853, #924 all running concurrently with no file conflicts.
- **3 issues found already fixed** (#845, #849, #822 WI4) — devs smoke-tested and confirmed, saving implementation time.
- **PO error analysis** produced 6 actionable issues (#926-#931) with data-driven prioritization.
- **Vite OOM fixed properly** — compilerBundlePlugin serves bundle via middleware (84MB vs 9.4GB), watcher excludes worktrees.

### What went wrong
- **Premature test262 reject** — compared #855 results against wrong baseline (17,782 vs 17,583). Almost blocked a +134 pass improvement. Need to always verify which baseline to compare against.
- **Told tester to rerun entire test262 unnecessarily** — the first run was valid, just compared wrong. Wasted ~10 min of compute.
- **#831 v2 may have false positives** — for-in/for-of LHS validation might reject valid destructuring patterns. test262 will catch this.
- **Bundle node: imports caused browser CORS errors** — three iterations to fix (createRequire → eval → top-level await → string replacement in plugin). Should have tested in browser earlier.
- **report.json corrupted by cat > same_file** — hardlink trap. Need atomic writes.
- **Task list not maintained** — forgot to create tasks at sprint start, only added them mid-sprint when asked.

### Process improvements
1. **Always verify baseline before rejecting** — document the exact baseline commit/run in the tester prompt
2. **Test in browser after any Node import changes** — playground is the canary
3. **Use atomic writes for report.json** — write to .tmp, then rename
4. **Create task list at sprint start, not mid-sprint** (reinforcing existing memory)
