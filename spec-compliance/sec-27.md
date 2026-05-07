# §27 Control Abstraction Objects (overview)

**Spec**: https://tc39.es/ecma262/#sec-control-abstraction-objects
**Status**: ⚠️ partial
**Test262 categories**: (none — covered transitively)
**Coverage**: not directly measured

## What the spec requires

Iterator, IteratorPrototype, Promise, GeneratorFunction, AsyncFunction, AsyncGeneratorFunction, DisposableStack, AsyncDisposableStack, SuppressedError.

## Current implementation

Files / runtime imports involved:

- `src/codegen/expressions.ts (await/yield)`
- `src/runtime.ts`
