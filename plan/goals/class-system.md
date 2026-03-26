# Goal: class-system

**Classes, inheritance, private fields, static blocks, accessors all work correctly.**

- **Status**: Blocked
- **Phase**: 2-3 (after core-semantics)
- **Target**: Class feature codegen complete. Estimated +1,200 tests.
- **Dependencies**: `core-semantics`

## Why

Classes are pervasive in test262. 1,161 tests fail due to class codegen gaps (#729).
This includes field initializers, static blocks, computed method names, and private
fields — all features used heavily in modern JS.

## Issues

| # | Title | Impact | Priority |
|---|-------|--------|----------|
| **729** | Class feature codegen gaps | 1,161 FAIL | Critical |
| **334** | Private class fields and methods | — | High |
| **377** | Getter/setter accessor edge cases | — | Medium |
| **329** | Object.setPrototypeOf support | — | Medium |
| **678** | Dynamic prototype chain (reverted — breaks struct layout) | 625 FAIL | High |
| ~~738~~ | ~~instanceof correctness~~ | ~~276 FAIL~~ | ~~Done~~ |

## Success criteria

- Class field initializers run in correct order
- Static blocks execute at class evaluation time
- Private fields (#field) work with inheritance
- Getter/setter accessors handle all edge cases
- Prototype chain supports dynamic modification
