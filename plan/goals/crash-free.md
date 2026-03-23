# Goal: crash-free

**No Wasm traps at runtime. Null dereferences and illegal casts produce proper JS exceptions.**

- **Status**: Active
- **Target**: Traps → 0. Pass rate ~45%.
- **Dependencies**: `compilable` (partial — tests must compile to crash)

## Why

Wasm traps (null deref, illegal cast) kill the entire module. In JS, these should
throw TypeError or similar. Converting traps to exceptions turns hard crashes into
catchable errors, which many test262 tests expect.

## Issues

| # | Title | Impact | Priority |
|---|-------|--------|----------|
| **728** | Null pointer dereference → TypeError, not trap | 1,604 FAIL | Critical |
| **512** | RuntimeError: illegal cast | 683 FAIL | Critical |
| **441** | Null pointer dereference (residual) | 129 FAIL | High |
| **315** | Wasm validation error audit | 93 CE | Medium |

## Success criteria

- Zero `RuntimeError: null` in test262 output
- Zero `RuntimeError: illegal cast` — all converted to TypeError
- Tests that expect TypeError for null access now pass
