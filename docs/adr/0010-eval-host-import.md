# ADR-010 — Dynamic eval() via host import

**Status**: Accepted
**Date**: 2026-04-27

## Context

`eval()` and `new Function(...)` require compiling source code at runtime —
the input is a string that may not exist until the moment of the call.
ADR-004 establishes that the js2wasm output performs no runtime code
generation. That decision interacts with `eval` directly: the compiler
cannot, at build time, lower an `eval(s)` whose argument `s` is not
statically known.

Four options exist for handling this. Refuse `eval` entirely (breaks
compatibility with any program that uses it, including indirectly via
common libraries). Stub it as a no-op (silently incorrect). Embed an
interpreter in every output module (violates ADR-004, adds binary
overhead, regresses cold start for the majority of modules that never
call `eval`). Or delegate to the host: the Wasm module asks the host to
compile a fresh Wasm module from the eval string and to instantiate it
with appropriate scope bridging.

## Decision

`eval()` is handled in two cases:

1. If the argument is a literal string known at compile time, the
   compiler folds the `eval` and lowers the embedded source as if it had
   appeared at the call site directly. No runtime support is needed.
2. Otherwise, the compiler lowers `eval` to a host import. The host
   receives the string, compiles a fresh Wasm module via the host's own
   compilation pathway (currently backed by a JS host or a Wasmtime host),
   instantiates it with the calling module's scope bridge, and returns
   the result. This path is consistent with the dynamic escape hatch
   principle of ADR-001: dynamic features fall back to dynamic
   representations, but they do not invalidate specialization elsewhere.

## Consequences

Positive: `eval()` works with full semantics on hosts that provide the
import — programs using `eval` do not need to be rewritten. The common
case of `eval("literal")` is handled without any host dependency at all.
The compiled module remains free of an embedded interpreter, so cold
start and binary size are not affected for the majority of modules that
never use `eval` dynamically.

Negative: dynamic `eval` is not available in standalone / WASI mode where
no compiler host is provided. There is no in-Wasm interpreter fallback;
hosts that do not provide the eval import simply cannot run dynamic
`eval` calls. Scope bridging is constrained — the host-compiled module
sees the calling module's scope through an explicit bridge, which limits
some of the more aggressive forms of `eval` that mutate the local scope
of the caller.

## Alternatives rejected

- **Native JS host eval**: unsafe — direct host eval can pollute the
  host's scope and is not consistent across runtimes.
- **Wait for the JIT proposal (`func.new` by Ben Titzer)**: the proposal
  exists but is not deployed; `eval` cannot be gated on it.
- **Embedded interpreter in every module**: violates ADR-004 and
  regresses size/cold-start for the majority of programs that do not use
  dynamic `eval`.
