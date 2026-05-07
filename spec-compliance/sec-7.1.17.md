# §7.1.17 ToString

**Spec**: https://tc39.es/ecma262/#sec-tostring
**Status**: ⚠️ partial
**Test262 categories**: covered by built-ins/String, JSON.stringify, template literals
**Coverage**: not directly measured

## What the spec requires

ToString fast paths: number → string uses `Number.prototype.toString` (host import or `__num_to_string` Wasm helper). null/undefined/boolean inline string literals. Object → string calls __to_primitive(hint=string) → ToString.

## Current implementation

Files / runtime imports involved:

- `src/codegen/type-coercion.ts`
- `src/runtime.ts (__num_to_string, __to_string)`

## Gap

Number formatting in standalone mode does not match the ECMAScript Number.prototype.toString algorithm exactly for non-integer values (issue #1321). Symbol → ToString does not throw TypeError as required by spec (must throw, but Symbol.prototype.toString allowed only via explicit call).
