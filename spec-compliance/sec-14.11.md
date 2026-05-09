# §14.11 with Statement

**Spec**: https://tc39.es/ecma262/#sec-with-statement
**Status**: ❌ not implemented
**Test262 categories**: `language/statements/with`
**Coverage**: 0 / 181 pass (0.0%) — 0 fail, 181 skip

## What the spec requires

`with` is a standard sloppy-mode ECMAScript statement. It is currently not implemented in js2wasm.
The last audit data still shows all 181 mapped tests as skipped from the older test262 filter.

## Current implementation

No dedicated implementation exists yet. Current validation rejects strict-mode `with` statements, and
there is no codegen path for sloppy-mode dynamic scope lookup.
