# Goal: property-model

**Object property semantics match the spec: descriptors, enumeration, freezing, hasOwn.**

- **Status**: Blocked
- **Target**: ~55% pass rate.
- **Dependencies**: `core-semantics`

## Why

JavaScript's property model is rich — configurable/writable/enumerable flags,
getters/setters, Object.freeze/seal, for-in enumeration order. Many test262 tests
verify these semantics. Getting them right unlocks downstream goals like
builtin-methods and iterator-protocol.

## Issues

| # | Title | Impact | Priority |
|---|-------|--------|----------|
| **732** | hasOwnProperty correctness | 520 FAIL | High |
| **739** | Object.defineProperty correctness | 262 FAIL | High |
| **488** | Property introspection hasOwnProperty | — | Critical |
| **359** | Object.freeze/seal/preventExtensions | — | Medium |
| **459** | Object.defineProperty getter/setter subset | — | Medium |
| **460** | Object.create for known prototypes | — | Medium |
| **239** | Element access on struct types (bracket notation) | — | Medium |
| **274** | Property access on function type (.name, .length) | — | Medium |

## Success criteria

- hasOwnProperty / propertyIsEnumerable match spec
- Object.defineProperty handles all descriptor combinations
- Object.freeze/seal/preventExtensions work correctly
- Property enumeration order matches spec (insertion order)
