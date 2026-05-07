# §11 ECMAScript Language: Source Text

**Spec**: https://tc39.es/ecma262/#sec-ecmascript-language-source-code
**Status**: ✅ conforming
**Test262 categories**: `language/source-text`, `language/line-terminators`, `language/white-space`, `language/comments`, `language/literals`, `language/asi`, `language/punctuators`
**Coverage**: 777 / 808 pass (96.2%) — 30 fail, 1 skip
**Top error buckets**: other=12, wasm_compile=8, assertion_fail=4

## What the spec requires

Source-text handling is delegated to the TypeScript compiler (typescript package). All Unicode escapes, line terminators, white space, and ASI rules pass.

## Current implementation

Files / runtime imports involved:

- `TypeScript parser (frontend)`

## Gap

line-terminators 33/41 — 8 wasm_compile failures (likely paragraph-separator U+2029 in identifiers).

## Issues filed / referenced

- [#1355](../plan/issues/sprints/50/1355-*.md)
