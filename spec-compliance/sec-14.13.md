# §14.13 Labelled Statements

**Spec**: https://tc39.es/ecma262/#sec-labelled-statements
**Status**: ✅ conforming
**Test262 categories**: (none — covered transitively)
**Coverage**: not directly measured

## What the spec requires

Labelled break/continue is implemented via a per-function label map matching nested blocks. Labels work across nested switch/loop combinations.

## Current implementation

Files / runtime imports involved:

- `src/codegen/statements.ts (labelMap)`
