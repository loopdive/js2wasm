---
id: 1341
sprint: 50
title: "spec gap: Iterator.prototype helpers wasm_compile errors (89 of 245 fails)"
status: ready
created: 2026-05-08
priority: high
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: iterator
goal: spec-completeness
parent: 1328
related: 1320, 1323
---
# #1341 — Iterator.prototype helper methods: wasm_compile failures

## Problem

`built-ins/Iterator/prototype`: **128 / 373 pass (34.3%) — 245 fails (121 assertion_fail,
89 wasm_compile, 11 runtime_error, 11 type_error, 7 other)**.

The 89 wasm_compile failures stand out: this means tests are failing at compile time
(not at runtime), suggesting a type-mismatch in the IR lowering of Iterator helpers
(`drop`, `take`, `map`, `filter`, `flatMap`, `some`, `every`, `find`, `forEach`, `reduce`,
`toArray`).

Spec §27.1.4.x requires each helper to:
1. Validate `this` is an Iterator (TypeError otherwise).
2. Wrap into a new iterator that lazily applies the operation.
3. Forward `.return()` to the underlying iterator on early completion.

## Acceptance criteria

1. `built-ins/Iterator/prototype/{drop,take}/argumenttype-*.js` compile without wasm_compile errors.
2. `built-ins/Iterator/prototype/{map,filter,flatMap}/callable-fn.js` pass.
3. wasm_compile error count for `built-ins/Iterator/prototype` drops from 89 to <10.
4. Pass-rate for `built-ins/Iterator/prototype` rises from 34% to ≥65%.

## Files to modify

- `src/codegen/registry/iterator-helpers.ts` (or wherever Iterator.* is registered)
- `src/codegen/expressions.ts` — call-expression dispatch for `Iterator.prototype.X`

## Implementation Plan

### Root cause

Each Iterator helper currently emits a closure-capturing call to a polymorphic `next()` that
expects an `(ref $Iterator)` but the actual `this` may be `externref` (host-iterable, e.g.
Set entries). The Wasm validator rejects the type mismatch.

### Approach

Coerce the receiver to externref at the helper entry, and use `__iterator_next` host bridge
(or the future pure-Wasm iterator protocol from #1323). Three options:

1. **Polymorphic dispatch** at call site: check `ref.test $Iterator` first; if true, fast path;
   else externref slow path.
2. **Single externref-only path**: simplest; requires #1323 (pure-Wasm iterator protocol) for
   standalone mode.
3. **Inline lowering**: each helper expands to a generator-style state machine. Most spec-correct
   but largest code-size impact.

Recommended: option (1) for sprint 50; revisit (3) when iterator-helper hot paths show up in
benchmarks.

### Edge cases

- `this` is not an Iterator (plain object with `next`) → spec says TypeError.
- Helper's callback throws → call `IteratorClose` on underlying iterator before re-raising.
- `flatMap`'s callback returns an iterable → recursively flatten one level.

### Test262 sample

- `test262/test/built-ins/Iterator/prototype/drop/argumenttype-undefined.js`
- `test262/test/built-ins/Iterator/prototype/map/callable-fn.js`
- `test262/test/built-ins/Iterator/prototype/flatMap/inner-generator-throw.js`
