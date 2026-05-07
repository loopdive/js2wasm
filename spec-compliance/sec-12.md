# §12 ECMAScript Language: Lexical Grammar

**Spec**: https://tc39.es/ecma262/#sec-ecmascript-language-lexical-grammar
**Status**: ⚠️ partial
**Test262 categories**: `language/identifiers`, `language/identifier-resolution`, `language/keywords`, `language/reserved-words`, `language/future-reserved-words`
**Coverage**: 358 / 389 pass (92.0%) — 16 fail, 15 skip
**Top error buckets**: runtime_error=8, other=3, negative_test_fail=2

## What the spec requires

Identifier and reserved-word handling are delegated to the TypeScript parser. Keywords/punctuators 100%; identifiers 93.7%.

## Current implementation

Files / runtime imports involved:

- `TypeScript parser`
