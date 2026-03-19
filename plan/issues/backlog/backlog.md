# ts2wasm Backlog

## Current — Test262 Error-Driven (March 2026)

_Latest run (2026-03-18): 15,740 tests — 5,770 pass, 17 fail, 13 CE, 9,940 skip._
_Down from 9,062 CE and 4,367 fail on 2026-03-16. Issues prioritized by test impact._

### In progress (3 agents)

| #                      | Feature                                                   | Type | Count | Priority |
| ---------------------- | --------------------------------------------------------- | ---- | ----- | -------- |
| [516](../ready/516.md) | struct.new argument count in class constructors           | CE   | 1,781 | High     |
| [521](../ready/521.md) | Yield keyword not recognized in nested contexts           | CE   | 53    | Medium   |
| [523](../ready/523.md) | Internal compiler errors: undefined .text + SpreadElement | CE   | 59    | Medium   |

### Open issues

| #                      | Feature                                           | Type  | Priority |
| ---------------------- | ------------------------------------------------- | ----- | -------- |
| [483](../ready/483.md) | Symbol() constructor — narrow skip filter         | Skip  | Medium   |
| [503](../ready/503.md) | Runner safe-write: don't corrupt report on crash  | Infra | High     |
| [506](../ready/506.md) | Remove redundant conformance-report.html          | Infra | Low      |
| [527](../ready/527.md) | Fix test262 script: use tsx instead of node       | Infra | Critical |
| [528](../ready/528.md) | Test262 runner: show progress when starting batch | Infra | Medium   |

### Future

| #                      | Feature                                                   | Priority |
| ---------------------- | --------------------------------------------------------- | -------- |
| [323](../ready/323.md) | Native type annotations (:i32, :f32, :u8) for performance | Low      |
| [74](./74.md)          | WASM SIMD for string and array operations                 | Low      |
| [130](./130.md)        | Shape inference Phase 4 — hashmap fallback + more methods | Medium   |

### Won't implement (fundamental JS runtime features)

| #               | Feature                                          | Reason                    |
| --------------- | ------------------------------------------------ | ------------------------- |
| [123](./123.md) | Wrapper constructors (new Number/String/Boolean) | JS legacy, TS discourages |
| [124](./124.md) | delete operator                                  | Fixed struct fields       |
| [125](./125.md) | Object.defineProperty / property descriptors     | Runtime metaprogramming   |
| [129](./129.md) | propertyHelper.js harness                        | Depends on #125           |

## Complexity legend

- XS: < 50 lines, one file
- S: < 150 lines, 1-2 files
- M: < 400 lines, 2-3 files
- L: > 400 lines, multiple files

## Completed (529 issues)

See `plan/issues/done/log.md` for the full completion log.
