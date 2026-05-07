# §29 Memory Model

**Spec**: https://tc39.es/ecma262/#sec-memory-model
**Status**: ❌ not implemented
**Test262 categories**: (none — covered transitively)
**Coverage**: not directly measured

## What the spec requires

The ECMAScript memory model is defined for shared memory + Atomics. Since we do not support SharedArrayBuffer, the memory model is trivially satisfied today (single-thread sequenced) — but it becomes a hard correctness requirement when multi-threaded Wasm support lands. Backlog issue #1353 tracks the eventual work.

## Current implementation

_No dedicated implementation files; see linked sub-sections._

## Issues filed / referenced

- [#1353](../plan/issues/sprints/50/1353-*.md)
