# Changelog

## Historical sprint tags

This file records the historical sprint boundary tags created from the sprint history in `plan/sprints/` and the Git history on `main`.

Tagging method:

- Use an explicit sprint-closing commit when one exists, for example `sprint-31 suspend`.
- Otherwise use the closest `main` snapshot that matches the documented sprint boundary and/or the archived `test262` run for that sprint.
- `sprint/32`, `sprint/34`, and `sprint/35` were not tagged because their sprint docs are still planning or incomplete.
- `sprint/33` does not exist in the current sprint history.

## Current test262 status

Latest complete archived full-suite entry: `20260331-215747` from [benchmarks/results/runs/index.json](/Users/thomas/Documents/Arbeit/Startup/Projekte/Mosaic/code/@loopdive/ts2wasm/benchmarks/results/runs/index.json)

- Pass rate: `15,155 / 48,174` = `31.5%`
- Previous full-suite entry: `15,246 / 48,174` = `31.7%`
- Note: [benchmarks/results/test262-report.json](/Users/thomas/Documents/Arbeit/Startup/Projekte/Mosaic/code/@loopdive/ts2wasm/benchmarks/results/test262-report.json) currently points to a missing target, so the pass rate above is sourced from the run index rather than the symlink.

## Sprint log

| Sprint | Tag | Snapshot | Summary | test262 |
|---|---|---|---|---|
| 1 | `sprint/1` | `2253526f` | First major conformance push. | `550 -> 1,509` pass |
| 2 | `sprint/2` | `0c30b60a` | Runtime failure reduction follow-up on the same day. | incremental, no isolated archived run |
| 3 | `sprint/3` | `f3752535` | Consolidated evening merge wave and rolled into Sprint 4/5 planning. | incremental, merged same session |
| 4 | `sprint/4` | `8c20e264` | Diagnostic suppression, bracket notation, destructuring, compound assignment. | incremental, multi-day session |
| 5 | `sprint/5` | `755a8602` | Deep runtime correctness fixes for coercion, equality, assignment, `instanceof`. | incremental runtime gains |
| 6 | `sprint/6` | `25936412` | Expanded test262 categories and runner infrastructure. | `1,952` pass, `2,248` compilable |
| 7 | `sprint/7` | `42110b21` | Continued runtime-pattern cleanup and skip-filter tightening. | later history records first end-of-day `~6,366` pass |
| 8 | `sprint/8` | `c2f6527c` | Property access, element access, class inheritance, skip-filter removal. | no dedicated full run archived |
| 9 | `sprint/9` | `1563004b` | Async/await, for-in, try/catch, class features, prototype-chain work. | no dedicated full run archived |
| 10 | `sprint/10` | `d4f2bf4b` | First recorded 23k-scale run and large runner perf work. | `6,366 / 23,021` |
| 11 | `sprint/11` | `46dc1a72` | Same-day feature push with minimal conformance change. | `6,366 / 23,025` |
| 12 | `sprint/12` | `ec256452` | Recovered from skip-filter regression. | `5,753 -> 7,139 / 22,974` |
| 13 | `sprint/13` | `08e9a4df` | Test set nearly doubled and pass count jumped sharply. | `9,560 / 47,983` |
| 14 | `sprint/14` | `b180c8be` | Dual-mode backends and compiler infrastructure. | `10,444 / 47,773` |
| 15 | `sprint/15` | `904dd789` | Continued type tracking, backlog cleanup, tooling. | `10,974 -> 15,244` |
| 16 | `sprint/16` | `56ed2846` | Error classification, type coercion, equivalence tests. | `15,232 / 48,097` |
| 17 | `sprint/17` | `5d345935` | `expressions.ts` refactor and goal-system work with regressions. | `15,232 -> 14,720 / 48,102` |
| 18 | `sprint/18` | `30853dae` | Goal-system migration and stabilization. | `14,720 / 48,102` |
| 19 | `sprint/19` | `fc59ad41` | Equivalence tests, RegExp, skip-filter work; recovered after a dip. | `14,120 -> 15,997 / 49,642` |
| 20 | `sprint/20` | `f98baabc` | Light maintenance day. | no archived full run |
| 21 | `sprint/21` | `7ba5d2e9` | Mutable closure captures, assertion failures, type errors. | `15,410 / 49,663` |
| 22 | `sprint/22` | `0226f60d` | Compile-away principle, new issues, memory/process work. | `15,579 / 49,833` |
| 23 | `sprint/23` | `ace7c225` | Afternoon/evening push toward 20k with protocol improvements. | `15,362 / 49,834` |
| 24 | `sprint/24` | `2dabfcc2` | ValueOf recursion, depth limiter, `String.prototype` unblock work. | `14,616 / 49,880` |
| 25 | `sprint/25` | `80858682` | Wave-4 merge, class/elements unblock, worker-thread execution. | `15,197 / 49,881` |
| 26 | `sprint/26` | `f975c489` | Honest-baseline reset and worker-thread transition. | sprint document records `13,289 / 36,828`; tag uses the nearest preserved boundary snapshot |
| 27 | `sprint/27` | `24e9295f` | Precompiler, cache, and vitest-runner overhaul. | `17,612 -> 18,546 / 48,086` |
| 28 | `sprint/28` | `94ddfda3` | PO analysis, runtime fix wave, closure semantics. | `18,117 -> 18,186 / 47,782` |
| 29 | `sprint/29` | `7ed3c456` | Team infrastructure, agent roles, checklists, runtime fixes. | `18,284 / 48,088` |
| 30 | `sprint/30` | `062a7da2` | High-impact test262 fixes, revert/retry cycle, 40% push. | `18,599 / 48,088` |
| 31 | `sprint/31` | `66e27dea` | Sprint redo ended in a documented suspend state. | baseline `15,246 / 48,174`; latest archived full run `15,155 / 48,174` |

## Notes

- Sprint 30 final numbers are documented in [plan/sprints/sprint-30.md](/Users/thomas/Documents/Arbeit/Startup/Projekte/Mosaic/code/@loopdive/ts2wasm/plan/sprints/sprint-30.md), but the archived run index currently preserves `18,284 / 48,088` while the sprint document preserves the final `18,599 / 48,088`.
- Sprint 26's documented final run is preserved in the sprint document, but not as a directly recoverable full-run SHA in the current run index; the tag therefore uses the nearest historical boundary snapshot.
