---
id: 1358
sprint: 51
title: "spec gap: Array.prototype.{filter,map,every,some,forEach,reduce} on array-like (.call) receivers — ~452 assertion_fail"
status: done
created: 2026-05-08
updated: 2026-05-08
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: arrays
goal: spec-completeness
parent: 1334
---
# #1358 — Array callback methods on generic array-like receivers

## Problem

`built-ins/Array/prototype/{filter,every,map,some,forEach}` is the largest single fail
cluster after sprint 50 lands. The vitest baseline shows:

| method   | fails | top error              |
|----------|-------|------------------------|
| filter   | 117   | 99 assertion_fail      |
| every    | 104   | 92 assertion_fail      |
| map      | 97    | 84 assertion_fail      |
| some     | 97    | 86 assertion_fail      |
| forEach  | 95    | 91 assertion_fail      |
| **total**| **510** | **452 assertion_fail** |

A representative failing pattern is:

```js
var obj = { 0: 11, 1: 9, length: 2 };
assert.sameValue(Array.prototype.every.call(obj, callbackfn), true);
```

…where `obj` is a plain array-like (has `length` + indexed properties but is not a Wasm
vec). The current `compileArrayLikePrototypeCall` (`src/codegen/array-methods.ts:339`)
DOES route through `__extern_length` / `__extern_get_idx`, but it returns `undefined`
(falls through) for several real-world receiver shapes:

1. **Receiver inside `assert.throws(...)`** — explicitly bailed (line ~403) so the
   throw can propagate; this swallows tests where the receiver is *intentionally* an
   array-like and the callback throws (e.g. `15.4.4.16-7-c-ii-8.js`).
2. **Receiver is a property access on a Wasm struct** (e.g. `Array.prototype.every.call(this.cfg, cb)`).
   `resolveArrayInfo` is consulted on the receiver type; when the static type is
   `{0: T, 1: T, length: number}` (anonymous tuple-like), the path picks the *vec* branch
   and emits `array.get $arr_T` against a struct — wasm_compile error.
3. **`thisArg` is a non-undefined value** — the array-like loop never threads thisArg
   into `call_ref`. Tests like `15.4.4.16-5-24.js` (`[11].every(cb, "abc")`) pass a string
   as `this`; the spec requires the callback to see `"abc"` as `this`, but our loop
   passes `null`/the receiver itself.
4. **Sparse arrays / holes**: `obj = { 0: 11, 2: 13, length: 3 }`. The spec requires
   `HasProperty(O, Pk)` before invoking the callback for index 1; we always invoke.

## Acceptance criteria

1. `built-ins/Array/prototype/every/15.4.4.16-1-15.js` passes (Array.prototype.every.call(obj, cb)).
2. `built-ins/Array/prototype/every/15.4.4.16-5-24.js` passes (thisArg threading).
3. `built-ins/Array/prototype/every/15.4.4.16-7-b-1.js` passes (sparse `HasProperty` check).
4. `built-ins/Array/prototype/filter/15.4.4.20-1-15.js` passes.
5. `built-ins/Array/prototype/forEach/15.4.4.18-7-c-i-23.js` passes.
6. Pass-rate for `built-ins/Array/prototype/{filter,every,map,some,forEach}` rises from
   ~10% to ≥60% — at least **+300 net passing tests**.

## Files to modify

- `src/codegen/array-methods.ts` — `compileArrayLikePrototypeCall` (line ~339), `setupArrayCallback` (line ~?), `buildCallAndCheck` (line ~?), and `emitArrayLoop`.
- `src/runtime.ts` — extend `__extern_get_idx` to return a sentinel for missing indices, OR add a separate `__extern_has_idx` import.

## Implementation Plan

### Root cause

`compileArrayLikePrototypeCall` was added as a narrow optimization for `[arr].method(cb)`
when the static type is array-like. It (a) bails out inside `assert.throws` to avoid
swallowing exceptions, and (b) doesn't thread `thisArg`. Both bail-outs/omissions cause
silent assertion_fail rather than the expected behaviour.

### Approach

#### 1. Drop the `assert_throws` bailout, but make the loop **propagate** thrown errors

Today the bailout exists because a Wasm-native loop catches the trap from `__extern_length`
internally, swallows it, and returns 0 — masking a TypeError that should propagate. Fix
this by:

- Removing the parent-walk that detects `assert_throws` (line ~403–414).
- Wrapping the `__extern_length` call and each per-index `__extern_get_idx` call in
  `try_table` (or rely on default Wasm exception propagation — these imports already
  re-throw via the host). No catch — let the trap walk up.
- Where the callback itself throws, the `call_ref` already lets the exception walk;
  no change needed.

Verify by checking `built-ins/Array/prototype/every/15.4.4.16-7-c-ii-8.js`: the callback
throws on i=2; spec says `every` re-throws at that point.

#### 2. Thread `thisArg` through the callback

`compileArrayLikePrototypeCall` already has access to `callExpr.arguments[1]` (or `[2]` for
reduce). After the loop preamble:

```ts
const thisArgLocal = allocLocal(fctx, "__arr_cb_this", { kind: "externref" });
if (callExpr.arguments.length >= 2) {
  compileExpression(ctx, fctx, callExpr.arguments[1]!);
  coerceType(ctx, fctx, lastType, { kind: "externref" });
} else {
  fctx.body.push({ op: "ref.null", refType: "extern" } as unknown as Instr);
}
fctx.body.push({ op: "local.set", index: thisArgLocal });
```

Then change the per-iteration callback invocation from `call_ref(cb)` (with `null` this)
to a helper that uses `Reflect.apply(cb, thisArg, [val, i, recv])`, OR add an import
`__call_with_this(fn: externref, thisArg: externref, ...args) -> externref`.

Pattern to follow: `compileArrayFlatMap` (line 5309) already passes `thisArg` to a host
import. Mirror that, but for the Wasm-native loop.

#### 3. `HasProperty` check for array-like sparse iteration

For each index `i` in the array-like loop:

```wasm
;; if (HasProperty(receiver, ToString(i)))
local.get $recv
local.get $i
call $__extern_has_idx        ;; returns i32 (1 if present, 0 if hole)
i32.eqz
br_if $skip_iter

;; else: invoke callback
```

Add `__extern_has_idx(externref, i32) -> i32` to runtime imports. Implementation in
`src/runtime.ts` is one line: `return Reflect.has(o, String(i)) ? 1 : 0;`.

For `forEach`/`every`/`some`/`filter`/`map`/`reduce`: this is mandatory per spec
§23.1.3.{12,7,28,11,21,24} (each has a `kPresent` step that gates the callback).

#### 4. Reject `__vec_*` and `__arr_*` static types when they look array-like

Already handled at line ~382. Verify the check is correct for nested tuple types
(e.g. `[number, number] & { length: 2 }`).

### Edge cases

- Receiver is `Object.create(null)` → `__extern_get_idx` returns `undefined` for every index;
  the spec calls for `HasProperty` first (returns false), so the callback is never invoked.
- `thisArg` is `undefined` in non-strict mode → coerced to global `this` per spec; in our
  module we always emit strict, so `undefined` stays as is — that's correct.
- `length` is non-integer → `ToLength` clamps to integer floor, `Math.min(length, 2^53-1)`.
- `length` getter throws → exception propagates (handled by point 1).
- `length` is `Infinity` → already bailed in `ARRAY_LIKE_METHOD_SET` comment for
  `map`/`filter`. Keep that bailout (compile-timeout is real).

### Test262 sample

- `test262/test/built-ins/Array/prototype/every/15.4.4.16-1-15.js` — generic .call on plain object
- `test262/test/built-ins/Array/prototype/every/15.4.4.16-5-24.js` — thisArg = "abc"
- `test262/test/built-ins/Array/prototype/every/15.4.4.16-7-b-1.js` — sparse HasProperty
- `test262/test/built-ins/Array/prototype/filter/15.4.4.20-1-15.js`
- `test262/test/built-ins/Array/prototype/forEach/15.4.4.18-7-c-i-23.js`
- `test262/test/built-ins/Array/prototype/map/15.4.4.19-1-15.js`
- `test262/test/built-ins/Array/prototype/some/15.4.4.17-1-15.js`

### Estimated impact

+300–400 passing tests. Pushes §23.1 from 46% to ~58%.
