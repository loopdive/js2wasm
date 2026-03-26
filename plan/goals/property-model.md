# Goal: property-model

**Object property semantics match the spec: descriptors, enumeration, freezing, hasOwn.**

- **Status**: Blocked
- **Phase**: 2-3 (after core-semantics)
- **Target**: Property descriptor semantics correct. Estimated +1,500 tests.
- **Dependencies**: `core-semantics`

## Why

JavaScript's property model is rich — configurable/writable/enumerable flags,
getters/setters, Object.freeze/seal, for-in enumeration order. Many test262 tests
verify these semantics. Getting them right unlocks downstream goals like
builtin-methods and iterator-protocol.

## Issues

| # | Title | Impact | Priority |
|---|-------|--------|----------|
| ~~732~~ | ~~hasOwnProperty correctness~~ | ~~520 FAIL~~ | ~~Done~~ |
| **739** | Object.defineProperty correctness | 262 FAIL | High |
| **488** | Property introspection hasOwnProperty | — | Critical |
| **359** | Object.freeze/seal/preventExtensions | — | Medium |
| **459** | Object.defineProperty getter/setter subset | — | Medium |
| **460** | Object.create for known prototypes | — | Medium |
| **239** | Element access on struct types (bracket notation) | — | Medium |
| **274** | Property access on function type (.name, .length) | — | Medium |
| **770** | propertyHelper verifyProperty in test262 preamble | 1,219 FAIL | High |
| **678** | Dynamic prototype chain traversal | 625 FAIL | High |
| **731** | Function/class .name property | 558 FAIL | Medium |
| **746** | Inline property tables (struct-based access) | Many FAIL | Medium |

## Success criteria

- hasOwnProperty / propertyIsEnumerable match spec
- Object.defineProperty handles all descriptor combinations
- Object.freeze/seal/preventExtensions work correctly
- Property enumeration order matches spec (insertion order)
