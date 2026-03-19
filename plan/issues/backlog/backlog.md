# ts2wasm Backlog

## Current — Test262 Full Suite (March 2026)

_Full run in progress (53,010 tests). Previous partial run (34,160/53k): 8,605 pass (25.2%), 7,350 fail, 10,631 CE, 7,574 skip._
_On supported categories (Math, Array, String, language/*): 98-99% pass rate._

### Open issues

| # | Feature | Type | Priority |
|---|---------|------|----------|
| [578](../ready/578.md) | WASI imports (fd_write, console.log bridge) | Feature | High |

### Backlog — JS runtime features

| # | Feature | Tests | Priority |
|---|---------|------:|----------|
| [123](./123.md) | Wrapper constructors (new Number/String/Boolean) | 648 | High |
| [124](./124.md) | delete operator via undefined sentinel | 232 | Medium |
| [129](./129.md) | propertyHelper.js harness stubs | 341 | Medium |
| [452](./452.md) | Compile TypeScript compiler to Wasm | — | Aspirational |

### Future — performance & extensions

| # | Feature | Priority |
|---|---------|----------|
| [323](../blocked/323.md) | Native type annotations (:i32, :f32, :u8) | Low |
| [74](./74.md) | WASM SIMD for string and array operations | Low |

## Complexity legend

- XS: < 50 lines, one file
- S: < 150 lines, 1-2 files
- M: < 400 lines, 2-3 files
- L: > 400 lines, multiple files

## Completed (577 issues)

See `plan/issues/done/log.md` for the full completion log.

Key milestones:
- React reconciler compiles to WasmGC, 2.3x faster than JS (1000-node tree)
- 98-99% pass rate on supported test262 categories
- 3 perf optimizations: O(1) struct dedup, funcType cache, batched index shifts
- Security: WAT escaping, path traversal fix, XSS defense
