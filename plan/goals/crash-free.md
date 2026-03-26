# Goal: crash-free

**No Wasm traps at runtime. Null dereferences and illegal casts produce proper JS exceptions.**

- **Status**: Active
- **Phase**: 1 (parallel with compilable)
- **Target**: Traps → 0. Convert ~2,600 traps/TypeError to proper exceptions. Estimated +1,500 tests.
- **Dependencies**: `compilable` (partial — tests must compile to crash)

## Why

Wasm traps (null deref, illegal cast) kill the entire module. In JS, these should
throw TypeError or similar. Converting traps to exceptions turns hard crashes into
catchable errors, which many test262 tests expect.

## Issues

| # | Title | Impact | Priority |
|---|-------|--------|----------|
| **780** | TypeError (null/undefined) in built-in method dispatch | 9,128 FAIL | Critical |
| **781** | TypeError (null/undefined) in language constructs | 2,841 FAIL | High |
| **785** | Null pointer traps in compiled Wasm code | 1,604 FAIL | High |
| **775** | Null pointer traps → catchable TypeError (targeted fix) | 1,604 FAIL | Critical |
| **728** | Null pointer dereference → TypeError, not trap (reverted — too broad) | 1,604 FAIL | Critical |
| **512** | RuntimeError: illegal cast | 683 FAIL | Critical |
| **441** | Null pointer dereference (residual) | 129 FAIL | High |
| **315** | Wasm validation error audit | 93 CE | Medium |
| **768** | throwOnNull regression fix | 6,478 FAIL | Critical | ✅ Done |

## Success criteria

- Zero `RuntimeError: null` in test262 output
- Zero `RuntimeError: illegal cast` — all converted to TypeError
- Tests that expect TypeError for null access now pass
