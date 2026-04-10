# File Locks

Active file/function claims by agents. **Check before editing. Update when starting/finishing work.**

## Protocol

1. **Before starting**: read this file, check for conflicts with your target files/functions
2. **If no conflict**: add your claim, then start work
3. **If conflict**: message the claiming agent to coordinate, or pick different work
4. **On completion**: remove your claim

## Active Locks

| File | Function/Area | Agent | Issue | Since |
|------|--------------|-------|-------|-------|
| index.html | nav HTML + CSS | dev-976 | #976 | 2026-04-06 |
| index.html | renderBenchmarkChart JS + bench CSS | dev-980 | #982 | 2026-04-06 |
| components/perf-benchmark-chart.js | new file | dev-980 | #982 | 2026-04-06 |
| public/benchmarks/report.html | renderBenchmarks + bench-card CSS | dev-980 | #982 | 2026-04-06 |
| scripts/build-pages.js | component copy list | dev-980 | #982 | 2026-04-06 |
| dashboard/index.html | nav insertion | dev-976 | #976 | 2026-04-06 |
| components/site-nav.js | new file | dev-976 | #976 | 2026-04-06 |
| src/codegen/property-access.ts | compileElementAccess, compilePropertyAccess | dev-848 | #848 | 2026-04-06 |
| src/codegen/expressions.ts | compileElementAssignment | dev-848 | #848 | 2026-04-06 |
| tests/test262-runner.ts | shouldSkip (FinalizationRegistry filter) | dev-988 | #988 | 2026-04-10 |

<!--
Example entries:
| src/codegen/expressions.ts | compileCallExpression | dev-1 | #512 | 2026-03-25 |
| src/codegen/type-coercion.ts | coerceType | dev-2 | #315 | 2026-03-25 |
| src/codegen/expressions.ts | compileBinaryExpression | dev-3 | #618 | 2026-03-25 |

Note: same FILE with different FUNCTIONS is OK (Git 3-way merge handles separate hunks).
Same function = conflict, must coordinate.
-->
