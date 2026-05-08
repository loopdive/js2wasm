---
id: 1367
sprint: 51
title: "spec gap: Iterator.prototype helpers — get-next-once, non-constructible, return-on-throw (~244 fails)"
status: ready
created: 2026-05-08
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen, runtime
language_feature: iterators
goal: spec-completeness
parent: 1340
---
# #1367 — Iterator helper protocol invariants

## Problem

`built-ins/Iterator/prototype/*` — **244 fails**, distinct from #1340 (which targets
`wasm_compile`). This issue covers the assertion-fail cluster: protocol invariants.

Top failing patterns:

- `Iterator/prototype/{drop,take,map,filter,every,some,forEach,find,reduce}/get-next-method-only-once.js` — spec says GetIteratorDirect calls `next` ONCE per `iterator.{drop|take|...}.next()` chain step.
- `Iterator/prototype/*/non-constructible.js` — `new iter.drop()` must throw TypeError.
- `Iterator/prototype/*/get-next-method-throws.js` — if `next` getter throws,
  the helper must propagate immediately (no buffer).
- `Iterator/prototype/*/return-method-{throws,returns-non-object}.js` — when the
  helper iterator's `.return()` is called (e.g. `for-of` early break), it must
  invoke the underlying iterator's `.return()`; if that returns non-object, throw.
- `Iterator/prototype/some/short-circuit.js` — `some` must early-return on truthy.
- `Iterator/prototype/every/short-circuit.js` — `every` must early-return on falsy.
- `Iterator/prototype/take/limit-rangeerror.js` — `take(-1)` throws RangeError; we
  silently coerce to 0 or run forever.

Spec §27.5 (Iterator Helper Objects) requires: every helper is an *object* that
holds the underlying iterator; calling `.next()` on the helper invokes the
underlying iterator's `.next()` exactly as many times as needed. Helpers are
non-constructible. They forward `.return()`.

Current state: `src/codegen/registry/` (per the spec audit doc) has iterator-helper
registry; the implementation likely materializes the helper as a JS function or a
Wasm closure that pre-fetches `.next` once per construction or repeatedly per call.

## Acceptance criteria

1. `built-ins/Iterator/prototype/drop/get-next-method-only-once.js` passes.
2. `built-ins/Iterator/prototype/drop/non-constructible.js` passes (`new iter.drop()` throws).
3. `built-ins/Iterator/prototype/take/limit-rangeerror.js` passes (`take(-1)` throws RangeError).
4. `built-ins/Iterator/prototype/some/short-circuit.js` passes.
5. `built-ins/Iterator/prototype/map/return-method-throws.js` passes.
6. Pass-rate for `built-ins/Iterator/prototype/*` rises from ~36% to ≥80%;
   **+170 net passes**.

## Files to modify

- `src/codegen/registry/iterator-helpers.ts` (or wherever iterator helpers are emitted).
- `src/runtime.ts` — helpers for `__iterator_helper_create`,
  `__iterator_helper_return`, etc.
- `src/codegen/expressions.ts` — `new iter.drop()` should be detected at compile
  time and emit TypeError; or runtime check.

## Implementation Plan

### Root cause

Helpers are likely currently emitted as direct closures that:

1. Fetch `iter.next` *every call* (instead of once, per spec).
2. Are constructible (we don't mark them as `[[Construct]]: undefined`).
3. Don't forward `.return()` on the helper to the underlying iterator's `.return()`.
4. Don't validate arguments before iteration begins (e.g. `take(NaN)` should throw,
   not silently iterate forever).

### Approach

#### A. Helper-object struct

Define a Wasm struct `$IteratorHelper`:

```
(type $IteratorHelper (struct
  (field $iter   (ref null any))      ;; underlying iterator
  (field $next   (ref null any))      ;; cached .next method
  (field $args   (ref null any))      ;; helper-specific state (e.g. limit, fn)
  (field $kind   i8)                  ;; 0=drop, 1=take, 2=map, 3=filter, ...
  (field $idx    i32)                 ;; counter for take/drop
  (field $done   i32)                 ;; 1 once underlying returned done=true
))
```

When `iter.drop(n)` is called:

1. Validate `n`: ToIntegerOrInfinity; if NaN or negative → RangeError.
2. Allocate `$IteratorHelper` with kind=0, args=n, iter=this.
3. Cache `iter.next` ONCE here (`$next` field); subsequent helper.next() calls reuse.
4. Return the helper.

When `helper.next()` is called:
1. If `$done`, return `{value: undefined, done: true}`.
2. Use cached `$next` to advance underlying.
3. Apply kind-specific transform.

#### B. Argument validation up-front

For `take`, `drop`: validate the limit synchronously (RangeError on bad input).
For `map`, `filter`, `flatMap`, `forEach`, `find`, `every`, `some`, `reduce`:
validate `fn` is callable synchronously (TypeError on bad input).

This means `iter.take(NaN)` throws *before* any underlying-iterator call.

#### C. Non-constructible

In `src/codegen/expressions.ts`, when emitting `new X(…)`:
- If X resolves at compile time to an iterator-helper method's result function
  (drop/take/etc.), emit `throw TypeError("not a constructor")`.
- Easier: at runtime, mark helper closures with `[[Construct]] = undefined`. For
  Wasm closures we can't do this directly; route via `__not_constructible_throw`.

Spec invariant: `Iterator.prototype.drop` itself is constructible? No — built-in
methods are non-constructible (`Iterator.prototype.drop.prototype === undefined`).
This is separate from `iter.drop(0)` returning a non-constructible helper object.

#### D. Forward `.return()`

When user code does:

```js
for (const x of iter.drop(2)) {
  if (x === STOP) break;
}
```

The for-of loop calls `helper.return()` on early break. The helper must:

1. Call `iter.return?.()` on the underlying iterator.
2. Validate that result is an object; if non-object, TypeError.
3. Return `{value: undefined, done: true}`.

Add a `__iterator_helper_return(helper)` runtime helper that does this.

This connects to #1347 (for-of IteratorClose on throw) and reinforces it.

### Edge cases

- `iter.take(0)` returns immediately with `done: true`; no underlying calls.
- `iter.take(Infinity)` is legal — iterate until underlying done.
- `iter.map(fn)` where `fn` throws on element 5 — propagate, call `iter.return()`.
- `iter.filter(fn)` where `fn` returns truthy on every element of an infinite iterator
  — never returns. This is fine — user's responsibility.
- Composing helpers: `iter.drop(2).take(3)` chains two helpers; outer helper's
  underlying is the inner helper.

### Test262 sample

- `test262/test/built-ins/Iterator/prototype/drop/get-next-method-only-once.js`
- `test262/test/built-ins/Iterator/prototype/drop/non-constructible.js`
- `test262/test/built-ins/Iterator/prototype/take/limit-rangeerror.js`
- `test262/test/built-ins/Iterator/prototype/some/short-circuit.js`
- `test262/test/built-ins/Iterator/prototype/map/return-method-throws.js`
- `test262/test/built-ins/Iterator/prototype/filter/return-method-on-callback-throw.js`

### Estimated impact

+170 passes. §27.1 lifts from 31% to ~65%.

## Implementation notes (senior-dev, 2026-05-08)

### Bridge approach (replaces architect's `$IteratorHelper` struct plan)

**Insight**: Modern V8 (Node 22+) ships full spec-compliant
`Iterator.prototype` with `.drop`, `.take`, `.map`, `.filter`, `.some`,
`.every`, `.find`, `.reduce`, `.toArray`, `.forEach`, `.flatMap`. These
already implement `[[AlreadyCalled]]`, `IteratorClose`, non-constructible,
RangeError on bad limit, etc. — every invariant the architect's plan
proposed re-implementing.

**Fix** (~30 LoC, two callsites): make synthesized iterators inherit
from `Iterator.prototype`, so helpers dispatch to the host engine's
spec-compliant impls.

Concrete changes:

1. **`src/runtime.ts:3397-3437`** (`__create_generator`): generator
   objects are now built via `Object.create(Iterator.prototype)` instead
   of plain object literal, so `.drop`/`.take`/etc. resolve through the
   prototype chain.

2. **`src/runtime.ts:3556-3580`** (`__iterator` vec fallback): wasm
   array/vec iterators are likewise built atop `Iterator.prototype`.

Both callsites detect `Iterator` global presence at runtime — fall back
to plain object on older runtimes (no regression, no hard dependency on
ES2024 Iterator).

### Probe results (4 of 5 cases solved by this single change)

| Case | Before | After |
|------|--------|-------|
| `arr[Symbol.iterator]().drop(2)` | "drop is not a function" | 3 (correct) |
| `gen().drop(2)` | "drop is not a function" | 3 (correct) |
| `it.take(-1)` (RangeError) | TypeError "take is not a function" | RangeError ✓ |
| `gen().some(p)` short-circuit | "some is not a function" | true ✓ |
| `new it.drop()` non-constructible | (host throw) wasm doesn't catch | Investigation needed |

The `new`-throws case (test 3 in probe) needs separate codegen work — our
`new` operator doesn't propagate the host's TypeError. Tracking as a
follow-up; not blocking this slice.

### Why the architect's `$IteratorHelper` struct isn't needed

The architect proposed a Wasm struct holding cached `.next`, `.args`,
`.kind`, `.idx`, `.done`. That's ~300 LoC. But:

1. V8's `Iterator.prototype.drop` ALREADY caches `.next` once per spec.
2. V8 ALREADY validates limits (RangeError on negative).
3. V8 ALREADY forwards `.return()`.
4. V8's helpers ARE non-constructible (built-in methods).

By inheriting from `Iterator.prototype`, we get all of this for free.
The only requirement is that our synthesized iterators have a callable
`.next` method (they do).

### Tests

- `tests/issue-1367.test.ts` — 7 unit tests covering drop/take/map/some/every/find/toArray on both array iterators and generators.
- All 7 pass locally.

### Estimated impact (revised down)

+50–100 net (vs architect's +170). Reasoning: the +170 estimate assumed
solving non-constructible and `new`-throw semantics, which need separate
codegen work. The bridge fix delivers most-but-not-all of the Iterator
prototype invariants.

### Standalone-mode caveat

This bridge fix only works when the JS host is present (`globalThis.Iterator`
defined). In standalone mode (WASI / no JS host), iterator helpers will
still fail. The architect's `$IteratorHelper` struct approach IS still
needed for full standalone parity. Tracking that as a follow-up; this
slice unblocks JS-host conformance immediately.
