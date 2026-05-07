# §9 Executable Code and Execution Contexts

**Spec**: https://tc39.es/ecma262/#sec-executable-code-and-execution-contexts
**Status**: ⚠️ partial
**Test262 categories**: `language/global-code`, `language/eval-code`, `language/module-code`
**Coverage**: 606 / 1035 pass (58.6%) — 417 fail, 12 skip
**Top error buckets**: assertion_fail=131, other=92, type_error=71

## What the spec requires

Global, function, eval, and module execution contexts are realized as Wasm functions with their own locals + a closure-capture struct. Lexical environment chains are represented by ref-cell structs threaded through nested functions.

## Current implementation

Files / runtime imports involved:

- `src/codegen/index.ts`
- `src/codegen/declarations.ts`

## Gap

eval-code is partially implemented (host-bridge); pure-Wasm eval is not feasible. Module-code: top-level await is not supported; cyclic imports work but error-binding propagation is incomplete.
