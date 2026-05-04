---
id: 779
title: "Assert failures: tests compile and run but produce wrong values (8,674 tests)"
status: ready
created: 2026-03-23
updated: 2026-04-09
priority: critical
feasibility: hard
reasoning_effort: max
goal: spec-completeness
test262_fail: 8674
sprint_role: analysis-only
---
# #779 -- Assert failures: tests compile and run but produce wrong values (8,674 tests)

## Problem

Tests fail with `returned 2` (first assertion failed) or other non-1 return
values. The code compiles, instantiates, and runs without crashing, but
produces incorrect values or fails the expected assertion semantics.

This remains the largest broad runtime-semantics umbrella, but it is now much
better split than when this issue was first written. Several former major
sub-buckets have already been broken out or completed.

### History
- 2026-03-25: 8,700 -> 7,096 after fixes #780-#787
- 2026-03-28 (initial): 10,988 (count increase from unblocking class/elements, String/prototype, directive-prologue, future-reserved-words tests that were previously skipped)
- 2026-03-28 (final): 10,099 (full 48K test run)
- 2026-04-07 official full recheck (`20260407-111308`): **8,674** assertion-failure-style `returned N` fails

### Current return code distribution (`20260407-111308`)

| Code | Count | Meaning |
|------|-------|---------|
| returned 2 | 6,502 | First assertion failed |
| returned 3 | 1,122 | Second assertion failed (first passed) |
| returned 5 | 399 | Fourth assertion failed |
| returned 4 | 287 | Third assertion failed |
| returned 6 | 98 | Fifth assertion failed |
| returned 10 | 72 | Ninth assertion failed |
| returned 7 | 71 | Sixth assertion failed |
| returned 0 | 25 | Early return / special control-flow cases |
| other (8+) | 98 | Later assertion failures |

### Current breakdown by category (`returned N` umbrella)

| Category | Count | Sub-issues |
|----------|-------|------------|
| language/statements | 2,150 | class elements / destructuring / for-of / for-await-of remain large |
| language/expressions | 2,023 | class elements / destructuring / assignment semantics remain large |
| built-ins/Object | 1,422 | defineProperty / defineProperties / Object.create still dominate |
| built-ins/Array | 692 | prototype and iteration semantics |
| built-ins/RegExp | 357 | host-wrapper and protocol semantics |
| annexB/language | 275 | eval/function Annex B semantics |
| built-ins/Date | 154 | |
| built-ins/Proxy | 141 | |
| built-ins/String | 135 | |
| language/arguments-object | 132 | trailing-comma / mapped-arguments behavior |
| built-ins/Iterator | 112 | |
| built-ins/Function | 101 | |
| built-ins/Number | 89 | |
| built-ins/Reflect | 73 | |
| language/eval-code | 70 | |
| built-ins/JSON | 57 | |
| language/function-code | 55 | |
| built-ins/ArrayBuffer | 55 | |
| language/module-code | 44 | |

### Highest-current residual families by path

| Path prefix | Count | Likely root cause |
|------------|-------|-------------------|
| `test/built-ins/Object/defineProperty` | 609 | descriptor validation / sidecar storage / boxing semantics |
| `test/language/statements/class/elements` | 395 | class element naming / static/private / computed member semantics |
| `test/language/expressions/class/elements` | 335 | class element naming / computed member semantics |
| `test/built-ins/Object/defineProperties` | 324 | descriptor validation / bulk-define behavior |
| `test/language/expressions/class/dstr` | 302 | class + destructuring interactions |
| `test/language/statements/class/dstr` | 289 | class + destructuring interactions |
| `test/language/statements/for-of/dstr` | 270 | iterator/destructuring runtime semantics |
| `test/built-ins/Object/create` | 222 | property model / prototype defaults |
| `test/language/statements/for-await-of` | 192 | async iteration semantics |
| `test/built-ins/RegExp` | 167 | host-wrapper/protocol gaps |

### Why the old issue text is now stale

Several major March buckets have already been split out or closed:

- [#797](../done/797.md) property descriptor subsystem — done
- [#847](../done/847.md) for-await-of / for-of destructuring wrong values — done
- [#848](../done/848.md) class computed property/accessor correctness — done
- [#849](../done/849.md) mapped arguments sync — done

This umbrella should now be read as “what still remains after those splits,” not
as a literal current decomposition of all wrong-value failures.

## Root causes (estimated breakdown)

| Root cause | Est. tests | Compiler file |
|-----------|-----------|---------------|
| Object descriptor / property-model residuals | ~1,200-1,500 | `src/codegen/expressions.ts`, `src/codegen/index.ts`, property sidecar paths |
| Class elements + computed/private/static semantics | ~700-900 | `src/codegen/index.ts`, class element lowering |
| Destructuring runtime semantics still not covered by narrower issues | ~700-900 | `src/codegen/statements.ts`, `src/codegen/expressions.ts` |
| `assert.throws`/wrong-exception semantics that are broader than #846 | ~1,500-2,000 | `src/codegen/expressions.ts`, `src/codegen/statements.ts` |
| RegExp host-wrapper / protocol semantics | ~300-400 | runtime host wrappers / RegExp built-ins |
| Annex B eval/function semantics | ~150-250 | eval lowering / Annex B runtime behavior |

## Sub-issues

- #739 Object.defineProperty correctness (262 fail)
- #786 Multi-assertion failures (returned N > 2)
- #846 assert.throws not thrown for invalid built-in arguments (2,799 fail)
- #1002 RegExp js-host mode completion

## Completed split-outs

- #797 property descriptor subsystem
- #847 for-await-of / for-of destructuring wrong values
- #848 class computed property and accessor correctness
- #849 mapped arguments object sync

## Acceptance criteria

- keep this as an umbrella / analysis issue, not a direct implementation target
- refresh counts and active sub-issues against the latest official-scope run
- ensure completed split-outs are removed from the active sub-issue list
- keep the residual active list focused on still-open root-cause buckets
