# Goal: standalone-mode

**All features work without a JS host runtime (WASI, wasmtime, edge platforms).**

- **Status**: Partially activatable (some issues ready now)
- **Target**: Full program execution under WASI.
- **Dependencies**: `iterator-protocol`, `generator-model` (these are the biggest host-import clusters)
- **Track**: Parallel — does not block conformance goals.

## Why

The dual-mode architecture (JS host optional) is a core project principle.
Standalone mode enables deployment to WASI, Fastly, Fermyon, Shopify Functions,
and any environment without a JS runtime. This follows the pattern of
#679 (dual string backend) and #682 (dual RegExp backend).

## Issues

| # | Title | Impact | Priority |
|---|-------|--------|----------|
| **680** | Wasm-native generators (state machines) | Standalone generators | Critical (XL) |
| **681** | Wasm-native iterators (struct-based) | Standalone iterators | High |
| **682** | RegExp: Wasm engine for standalone, host for JS mode | Standalone regex | Medium (Hard) |
| **638** | Reverse typeIdxToStructName map | O(N) → O(1) | Low |

## Success criteria

- Generator-using programs run under wasmtime
- Iterator protocol works without JS host
- RegExp basic patterns work in standalone mode
- `--target wasi` produces fully functional binaries for real programs
