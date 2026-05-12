# §B Annex B (Additional ECMAScript Features for Web Browsers)

**Spec**: https://tc39.es/ecma262/#sec-additional-ecmascript-features-for-web-browsers
**Status**: ⚠️ partial
**Test262 categories**: `annexB`
**Coverage**: 555 / 1086 pass (51.1%) — 531 fail, 0 skip
**Top error buckets**: assertion_fail=382, type_error=106, other=18

## What the spec requires

Annex B legacy methods: String.prototype.{anchor, big, blink, bold, fontcolor, fontsize, fixed, italics, link, small, strike, sub, sup, substr, trimLeft, trimRight}; escape/unescape; RegExp legacy accessors ($1...$9). 555/1086 (51.1%) pass.

## Current implementation

Files / runtime imports involved:

- `src/codegen/registry (escape/unescape)`

## Gap

RegExp legacy accessors and pre-ES6 RegExp tests covered by follow-up work.
