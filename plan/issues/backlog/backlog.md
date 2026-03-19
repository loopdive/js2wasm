# ts2wasm Backlog

## Current — Test262 Error-Driven (March 2026)

_Latest run (2026-03-19): 15,750 tests — 5,771 pass (36.7%), 24 fail, 15 CE, 9,940 skip._
_Compilable rate: 99.8% (5,795/5,810 non-skipped tests compile successfully)._
_Down from 6,912 CE and 2,197 fail on 2026-03-17._

### Remaining issues

| # | Feature | Type | Priority |
|---|---------|------|----------|
| [483](../ready/483.md) | Symbol() constructor — narrow skip filter | Skip | Medium |

### Future

| # | Feature | Priority |
|---|---------|----------|
| [323](../ready/323.md) | Native type annotations (:i32, :f32, :u8) for performance | Low |
| [74](./74.md) | WASM SIMD for string and array operations | Low |
| [130](./130.md) | Shape inference Phase 4 — hashmap fallback + more methods | Medium |

### Won't implement (fundamental JS runtime features)

| # | Feature | Reason |
|---|---------|--------|
| [123](./123.md) | Wrapper constructors (new Number/String/Boolean) | JS legacy, TS discourages |
| [124](./124.md) | delete operator | Fixed struct fields |
| [125](./125.md) | Object.defineProperty / property descriptors | Runtime metaprogramming |
| [129](./129.md) | propertyHelper.js harness | Depends on #125 |

## Complexity legend

- XS: < 50 lines, one file
- S: < 150 lines, 1-2 files
- M: < 400 lines, 2-3 files
- L: > 400 lines, multiple files

## Completed (561 issues)

See `plan/issues/done/log.md` for the full completion log.
