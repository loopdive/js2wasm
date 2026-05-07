# §8 Syntax-Directed Operations

**Spec**: https://tc39.es/ecma262/#sec-syntax-directed-operations
**Status**: ⚠️ partial
**Test262 categories**: (none — covered transitively)
**Coverage**: not directly measured

## What the spec requires

Static semantics are enforced by the TypeScript compiler at parse time (early errors, contains-checks). Most early-error categories are not surfaced as test262 negative-syntax tests because TypeScript parses them.

## Current implementation

Files / runtime imports involved:

- `src/checker`
- `src/ir/lower.ts`
