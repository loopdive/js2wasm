# Goal: async-model

**Promises, async/await, async generators, and for-await-of all work correctly.**

- **Status**: Blocked
- **Target**: ~75% pass rate.
- **Dependencies**: `generator-model` (async functions desugar to generators internally)

## Why

Async JavaScript is everywhere. Promise chains, async/await, and async generators
are used in virtually all modern codebases. ~300 test262 tests are for Promise
methods alone, and async generators depend on both the generator model and
promise infrastructure.

## Issues

| # | Title | Impact | Priority |
|---|-------|--------|----------|
| **764** | Promise chain methods (.then, .catch, .finally) | ~300 FAIL | Critical |
| **735** | Async iteration correctness | 329 FAIL | High |
| **675** | Dynamic import() | 471 tests | Medium |

## Dual-mode approach

**JS host mode**: Delegate Promise/.then() to JS host — natural fit since the
JS host already has an event loop and microtask queue.

**Standalone mode**: Implement promise state machine with WasmGC struct callback
queues and a run loop. Harder but necessary for WASI.

## Success criteria

- `.then()` chains resolve in correct order
- `.catch()` handles rejections
- `.finally()` runs regardless of outcome
- `async function` / `await` works end-to-end
- `for-await-of` iterates over async iterables
- `Promise.all/race/allSettled/any` all work
