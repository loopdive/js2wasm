# §16 ECMAScript Language: Scripts and Modules

**Spec**: https://tc39.es/ecma262/#sec-ecmascript-language-scripts-and-modules
**Status**: ⚠️ partial
**Test262 categories**: `language/global-code`, `language/module-code`, `language/import`, `language/export`
**Coverage**: 427 / 837 pass (51.0%) — 397 fail, 13 skip
**Top error buckets**: other=127, assertion_fail=106, wasm_compile=70

## What the spec requires

Scripts compile to a single Wasm module with a `_start` entry. ESM modules emit one Wasm function per module + a binding map. CJS rewriter converts require() to ESM imports during compile.

## Current implementation

Files / runtime imports involved:

- `src/codegen/index.ts (module wrapper)`
- `src/cjs-rewrite.ts`

## Gap

Module-code 55%, import 33%. Top-level await not supported. Cyclic imports work but error-binding propagation incomplete. import.meta partially supported (only.url).
