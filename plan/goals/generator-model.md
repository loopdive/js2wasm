# Goal: generator-model

**Generators work as lazy state machines with full protocol support (.next, .return, .throw, yield*).**

- **Status**: Blocked
- **Phase**: 3-4 (after iterator-protocol)
- **Target**: State-machine generators, yield delegation. Estimated +500 tests.
- **Dependencies**: `iterator-protocol` (generators produce iterators)

## Why

Generators are the foundation for async/await desugaring and lazy evaluation.
The current eager-buffer implementation is fundamentally broken (infinite generators
are impossible, lazy evaluation lost). State machine transformation fixes this and
enables standalone mode.

## Issues

| # | Title | Impact | Priority |
|---|-------|--------|----------|
| **680** | Wasm-native generators (state machines) + JS host fallback | Eliminates 10+ imports | Critical (XL) |
| **762** | Generator .next(value) arguments | ~50 FAIL | Medium |
| **287** | Generator function CEs — yield in loops/try | 119 CE | Medium |
| **288** | Try/catch/finally in generators | 40 CE | Medium |
| **762** | Generator .next(value) arguments silently ignored | ~50 FAIL | Medium |

## Phased approach (from #680)

- Phase 1: Simple sequential yields (60% of generator tests)
- Phase 2: Yield in loops/conditionals (85%)
- Phase 3: yield*, return(), throw() (95%)

## Success criteria

- Infinite generators work (`function* count() { let i = 0; while(true) yield i++; }`)
- `.next(value)` passes value as yield result
- `yield*` delegates to sub-generators
- `.return()` / `.throw()` work correctly
- Generators work in both JS host mode and standalone mode
