# §15.2 Function Definitions

**Spec**: https://tc39.es/ecma262/#sec-function-definitions
**Status**: ⚠️ partial
**Test262 categories**: (none — covered transitively)
**Coverage**: not directly measured

## What the spec requires

FunctionDeclarations are hoisted to top of scope. Hoisting respects var-vs-let-vs-const.

## Current implementation

Files / runtime imports involved:

- `src/codegen/index.ts`
