# Goal: symbol-protocol

**All well-known symbols work: toPrimitive, species, toStringTag, hasInstance, match/replace/search/split.**

- **Status**: Blocked
- **Phase**: 3-4 (after iterator-protocol)
- **Target**: Well-known symbols implemented. Estimated +400 tests.
- **Dependencies**: `iterator-protocol` (Symbol.iterator is the first well-known symbol)

## Why

Well-known symbols are JavaScript's extension points. Symbol.toPrimitive controls
type coercion, Symbol.species controls constructor identity for derived classes,
Symbol.hasInstance controls instanceof. Many test262 tests use these protocols.

## Issues

| # | Title | Impact | Priority |
|---|-------|--------|----------|
| **482** | Symbol.toPrimitive | — | High (blocked by #481) |
| **484** | Symbol.species | — | Medium (blocked by #481) |
| **485** | Symbol RegExp protocol (match, replace, search, split) | — | Medium (blocked by #481) |
| **486** | Symbol.toStringTag / Symbol.hasInstance | — | Medium (blocked by #481) |
| **487** | User Symbol as property key | — | Medium (blocked by #481, #483) |
| **483** | Symbol() constructor narrow filter | — | Medium |

## Success criteria

- `Symbol.toPrimitive` controls object-to-primitive conversion
- `Symbol.species` respected in Array/Promise/RegExp subclasses
- `Symbol.hasInstance` controls `instanceof`
- `Symbol.toStringTag` controls `Object.prototype.toString`
- User-defined symbols work as property keys
