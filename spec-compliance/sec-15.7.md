# §15.7 Class Definitions

**Spec**: https://tc39.es/ecma262/#sec-class-definitions
**Status**: ⚠️ partial
**Test262 categories**: `language/expressions/class`, `language/statements/class`
**Coverage**: 5629 / 8426 pass (66.8%) — 2790 fail, 7 skip
**Top error buckets**: assertion_fail=1516, runtime_error=477, type_error=412

## What the spec requires

Classes compile to a constructor function + a per-instance struct + a separate vtable for methods. Static fields/methods are emitted on the constructor function. Private fields use a parallel struct.

## Current implementation

Files / runtime imports involved:

- `src/codegen/class-bodies.ts`

## Gap

Coverage ~67% across class expression+statement. Largest fail buckets: assertion_fail (1500+) — instance method this-binding, static initialization order, super-class field shadowing. Computed property names with side-effects: 31%.
