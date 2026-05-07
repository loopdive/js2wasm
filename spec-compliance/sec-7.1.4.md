# §7.1.4 ToNumber

**Spec**: https://tc39.es/ecma262/#sec-tonumber
**Status**: ⚠️ partial
**Test262 categories**: covered by built-ins/Number, language/expressions/unary-plus
**Coverage**: not directly measured

## What the spec requires

ToNumber for typed paths is inlined to Wasm numeric ops. ToNumber on externref delegates to host import `__to_number`. String → number uses host JavaScript parser (also matches spec for hex/binary/octal/decimal literals + leading/trailing whitespace).

## Current implementation

Files / runtime imports involved:

- `src/codegen/type-coercion.ts`
- `src/runtime.ts (__to_number)`

## Gap

Standalone (no-host) mode falls back to `parseFloat` only — does not implement the full StringNumericLiteral grammar (hex `0x`, binary `0b`, octal `0o`, leading/trailing whitespace). Symbol → ToNumber should throw TypeError; currently returns NaN in some paths.
