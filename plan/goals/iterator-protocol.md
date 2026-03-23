# Goal: iterator-protocol

**Symbol.iterator protocol works for all iterables: arrays, maps, sets, generators, custom objects.**

- **Status**: Blocked
- **Target**: ~65% pass rate.
- **Dependencies**: `class-system` (Symbol support requires proper class/prototype chain)

## Why

The iterator protocol is an architectural keystone. Without it:
- `for-of` only works on arrays
- Map/Set iteration fails
- Spread on non-arrays crashes
- Destructuring from iterables is broken
- Generator consumption doesn't work

Fixing this unblocks Symbol.toPrimitive, Symbol.species, and all user-defined iterables.

## Issues

| # | Title | Impact | Priority |
|---|-------|--------|----------|
| **766** | Symbol.iterator protocol for custom iterables | ~500 FAIL | Critical |
| **481** | Symbol.iterator implementation | — | Critical |
| **761** | Rest/spread elements in destructuring | ~200 FAIL | High |
| **353** | For-of with generators and custom iterators | — | Medium |
| **456** | Well-known Symbol support (Symbol.iterator, toPrimitive) | ~1,767 skip | Critical |
| **495** | Array-like objects | — | Medium (blocked by #488) |

## Success criteria

- `for-of` works on Map, Set, generators, custom iterables
- Spread operator (`...`) works on any iterable
- Destructuring rest elements capture remaining items from iterables
- Array.from() works with iterables
