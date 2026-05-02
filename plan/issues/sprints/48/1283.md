---
id: 1283
title: "WeakMap host-import dispatch: type-mismatch on set/get/has/delete (carved off from #1242)"
status: ready
created: 2026-05-02
updated: 2026-05-02
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen, runtime
language_feature: WeakMap
goal: spec-completeness
related: [1242, 1244]
---

# #1283 — WeakMap host-import dispatch: type-mismatch on set/get/has/delete

## Background

Carved off from #1242 (WeakMap/WeakSet backed by strong refs). #1242 was
mostly stale-issue (WeakSet works on main today), but **WeakMap fails
with wasm validation errors at instantiation** for every documented
acceptance pattern. Tech lead approved a partial PR (test-only for
WeakSet) and filed this issue to fix the WeakMap path properly.

## Reproductions on origin/main (2026-05-02)

All run through `compile()` + `WebAssembly.instantiate()`:

```js
// CASE A: set/get with primitive value
const wm = new WeakMap();
const k = { id: 1 };
wm.set(k, 42);
return wm.get(k);
```
→ `call[0] expected type externref, found call of type f64 @+340`

```js
// CASE B: set/has after set
const wm = new WeakMap();
const k = { id: 1 };
wm.set(k, 99);
return wm.has(k) ? 1 : 0;
```
→ `call[2] expected type f64, found call of type externref @+318`

```js
// CASE C: cycle-detection (lodash cloneDeep style)
const seen = new WeakMap();
const a = { id: 1 };
seen.set(a, a);
return seen.has(a) ? 1 : 0;
```
→ `call[2] expected type f64, found local.get of type externref @+285`

```js
// CASE D: memoize style (lodash memoize)
const cache = new WeakMap();
function memo(arg) {
  if (cache.has(arg)) return cache.get(arg);
  const result = { value: 42 };
  cache.set(arg, result);
  return result;
}
```
→ `call[0] expected type externref, found call of type f64 @+734`

**WeakSet works fine** with the same `externMethod()` helper — so the
issue is specific to the WeakMap host-import wiring.

## Root cause hypothesis

`src/codegen/index.ts:5770-5784` registers WeakMap as an extern class
with `externMethod(N)` signatures (all-externref params, externref
result). That mirrors WeakSet (line 5787-5802) which works.

The dispatch in `src/codegen/expressions/extern.ts:39
compileExternMethodCall` calls
`compileExpression(ctx, fctx, callExpr.arguments[i]!, hint)` with the
extern-method param hint (externref). The hint should drive coercion to
externref, but the wasm validator says f64 leaks through for WeakMap
specifically.

Possibilities:
1. The hint isn't being honored for the second `set` argument when the
   value is a numeric literal — compileExpression returns f64 regardless.
2. The result-type wiring claims externref but the actual host import
   has a different signature (returns f64?), causing the validator to
   complain at the call's downstream consumer.
3. WeakMap's host-import resolution ends up at a different runtime
   helper than expected (Map's helper?), with mismatched signature.
4. The class-tag dispatch routes WeakMap to a different `externMethod`
   table than the one registered, so the runtime sees Map-shaped args
   while the codegen emits WeakMap-shaped ones.

## Investigation steps

1. Add a unit test that compiles `new WeakMap(); wm.set(k, 42); wm.get(k)`
   and dumps the wasm function for `set`/`get` with `wasm-dis`. Compare
   to the equivalent `new Map(); m.set(...)` which works.
2. Inspect the host-import name registered for `WeakMap_set` /
   `WeakMap_get` and confirm its function-type matches the
   `externMethod(N)` registration.
3. Check `src/runtime.ts:buildImports` to see if there's a
   WeakMap-specific resolver that returns a function with a different
   signature than expected.
4. If the hint coercion is the bug: instrument `compileExpression` with
   `{ kind: "externref" }` hint on a numeric literal and check whether
   it boxes via `__box_number`.

## Acceptance criteria

1. All four CASE A–D reproductions above compile and run correctly.
2. `_.memoize(fn)(arg)` returns the correct cached result on repeat calls.
3. `_.cloneDeep` on `a.self = a` does not infinite-loop and returns a
   structurally correct clone.
4. `tests/issue-1283.test.ts` covers all four CASE patterns.
5. No regression in WeakSet (already-working) or Map/Set tests.

## Out of scope

- Wasm-native WeakMap (separate issue #1103).
- WeakRef / FinalizationRegistry (separate issue #1101).

## Related

- #1242 — Original WeakMap/WeakSet issue; partial PR landed WeakSet
  tests, deferred WeakMap to this issue.
- #1244 — Hono stress test that also surfaces lodash-shaped WeakMap
  use.
- #1101, #1103 — Stronger Wasm-native variants.
