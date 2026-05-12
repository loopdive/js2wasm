# §22.1 String Objects

**Spec**: https://tc39.es/ecma262/#sec-string-objects
**Status**: ⚠️ partial
**Test262 categories**: `built-ins/String`
**Coverage**: 775 / 1223 pass (63.4%) — 447 fail, 1 skip
**Top error buckets**: assertion_fail=171, other=151, runtime_error=45

## What the spec requires

Strings are dual-mode: wasm:js-string (host) or WasmGC i16-array (--nativeStrings). All String.prototype methods (slice, substring, indexOf, includes, startsWith, endsWith, split, replace, replaceAll, match, matchAll, normalize, padStart, padEnd, repeat, trim\*, iterator, charAt, charCodeAt, codePointAt, fromCharCode, fromCodePoint, raw,...).

## Current implementation

Files / runtime imports involved:

- `src/codegen/string-ops.ts`
- `src/codegen/native-strings.ts`

## Gap

775/1223 (63.4%). String.prototype.normalize (NFD/NFC) requires host. Unicode case-folding (toLocaleUpperCase) not full ICU. Tagged templates with side-effects on cooked array: partial.
