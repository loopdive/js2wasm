---
id: 1352
sprint: ~
title: "RegExp exec result: wasmGC string struct ≠ externref string in strict equality (S15.10.2 cluster)"
status: backlog
created: 2026-05-08
priority: medium
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: runtime, codegen
language_feature: regexp, strings
goal: spec-completeness
parent: 1333
---
# #1352 — RegExp exec result: wasmGC string struct ≠ externref V8 string in strict equality

## Problem

~40 test262 failures in the S15.10.2 cluster (legacy RegExp exec-result tests) fail not because
of broken RegExp semantics, but because of a **strict-equality mismatch** between:

- Elements returned by V8's `RegExpExec` — externref JS strings (e.g. `"42"`)
- Expected values constructed in js2wasm — wasmGC `i16` string structs (e.g. `__expected = ["42"]`)

When a test does:
```js
assert.sameValue(result[0], "42"); // result[0] is externref string, "42" is wasmGC struct
```

The `===` comparison in the host bridge (`__host_eq`, `src/runtime.ts:121`) does identity
comparison on the externref side. A wasmGC string struct is never `===` to an externref V8 string
even when they contain the same characters.

## Sample failures

- `built-ins/RegExp/S15.10.2.7_A1_T1.js` (and ~39 sibling S15.10.2.* tests)

All follow the same pattern:
1. Construct an expected array of strings using JS literals (wasmGC struct path)
2. Run a regex and get the exec result (externref V8 array with externref string elements)
3. Compare element-by-element via `assert.sameValue` (or `===`)

## Root cause

`__host_eq` (the host import used for `===` between externref values) does not handle the case
where one operand is a wasmGC string struct and the other is a V8 externref string. It falls back
to reference identity, which is always false across the wasmGC/JS boundary.

The fix is either:
1. In `__host_eq`, detect when one arg is a wasmGC string struct (via `_isWasmStruct` +
   checking for the string-struct layout) and stringify it before comparing — `String(a) === b`.
2. Or: teach the RegExp exec-result bridge to convert V8 string elements in the result array
   to wasmGC string structs before returning.

Option 1 is broader and fixes all strict-equality mismatches between wasmGC strings and
externref strings, not just in RegExp. Option 2 is narrower but safer.

## Scope

This is broader than RegExp — any host value containing strings that js2wasm then compares with
a locally-constructed string will hit the same mismatch. The RegExp exec-result tests are just
the most visible manifestation.

See also: `#983 — wasmGC objects leak to JS` (related cross-boundary equivalence problem).

## Acceptance criteria

- S15.10.2.7_A1_T1.js through S15.10.2.7_A4_T10.js (the exec-result cluster) pass
- `===` between wasmGC string struct and V8 externref string with same content returns `true`
- No regression in existing string comparison tests

## Files to modify

- `src/runtime.ts` — `__host_eq` (or whichever equality bridge is used for `===`)
- Possibly `src/codegen/expressions.ts` — where `===` / `!==` is emitted for externref vs ref

## Notes

Filed from #1333 triage (architect-regexp, 2026-05-08). The S15.10.2 cluster was explicitly
deferred out of #1333 scope to avoid scope creep. Fix here unlocks ~40 tests.
