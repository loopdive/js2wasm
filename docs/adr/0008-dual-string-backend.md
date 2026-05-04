# ADR-008 — Dual string backend (wasm:js-string vs WasmGC i16 arrays)

**Status**: Accepted
**Date**: 2026-04-27

## Context

JavaScript strings are immutable UTF-16 code-unit sequences with rich,
spec-defined operations (concatenation, slicing, regex matching, locale
folding, code-point iteration). Two viable representations exist for them
in Wasm.

The first is the `wasm:js-string` builtins proposal, which exposes the
host's native string operations as Wasm imports under a reserved namespace.
A js2wasm module compiled against this backend uses the host's own string
representation and operations, which is fast and identical to the host's
intrinsic semantics. The cost is that a JS host (or a wasm:js-string
polyfill loaded alongside the module) must be present at runtime.

The second is a pure-WasmGC representation: strings as `(array i16)` with
all operations implemented in Wasm. This works in any WasmGC host —
including WASI, Wasmtime without JS embedding, and standalone runtimes —
but every string operation must be implemented in the compiler's runtime
library and validated against the spec.

Neither backend is universally better: the JS-host backend is faster and
smaller where it works; the WasmGC backend is the only option where it does
not.

## Decision

Provide both backends, selectable at compile time. The default is the
`wasm:js-string` backend for JS-hosted targets. The `--nativeStrings` flag
selects the WasmGC i16-array backend, and `--target wasi` implies it.

The WasmGC backend is implemented to expose the same API surface as the
`wasm:js-string` import set, so a module compiled with one backend can be
swapped to the other without changing the Wasm-level call sites.

## Consequences

Positive: standalone Wasm targets (WASI, Wasm components without a JS
embedding) are first-class — strings are not a feature gated on the host.
JS-hosted targets keep the performance of host-native string operations
for the common case. The two backends share a Wasm-level interface, so
optimization passes do not need to know which backend is in use.

Negative: every string operation has to be implemented twice and the two
implementations must agree on observable semantics. The WasmGC backend is
slower than host-native strings on JS hosts — string-heavy workloads in
WASI mode will not match JS-host performance. Maintenance cost is higher
than a single backend.

## Alternatives rejected

- **`wasm:js-string` only**: rejected because it forecloses standalone /
  WASI targets, which are a primary use case for an AOT JS-to-Wasm
  compiler.
- **WasmGC i16-array only**: rejected because it gives up host-native
  string performance unconditionally on the JS-host targets, where it is
  the easiest performance win available.
