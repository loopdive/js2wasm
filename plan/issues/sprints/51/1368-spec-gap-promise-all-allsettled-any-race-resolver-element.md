---
id: 1368
sprint: 51
title: "spec gap: Promise.{all,allSettled,any,race} — resolver-element semantics, ctor type-check (~109 fails)"
status: ready
created: 2026-05-08
priority: medium
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: runtime, codegen
language_feature: promises
goal: spec-completeness
---
# #1368 — Promise.{all,allSettled,any,race}: resolver-element + ctor type-check

## Problem

`built-ins/Promise/{all,allSettled,any,race}` — 31+37+22+19 = **109 fails**.

Top errors: `'other' (43)`, `'promise_error' (38)`, `'assertion_fail' (29)`,
`'wasm_compile' (10)`.

Common error messages:

- `'[object Object] is not a constructor'` (43+)
- `'Promise.all called on non-object'`
- `'invoke-resolve-element-after-return'` (resolver function still invokable after
  return)
- `'invoke-then-error-close'` (assertion_fail — error path missing iterator close)

Spec §27.2.4.1 (Promise.all) algorithm:

1. Let `C` be `this`. If not Object → TypeError. (Spec calls
   `IsConstructor(C)`; if false, TypeError.)
2. Let `promiseCapability` be `NewPromiseCapability(C)`.
3. Let `iteratorRecord` be `GetIterator(iterable, sync)`.
4. Resolve element: each element gets a unique resolver function. After ALL elements
   resolve, the outer promise resolves with the values array.
5. The resolver is "called once" per spec — internal slot `[[AlreadyCalled]]`.
6. If the iterator throws during iteration, must call `IteratorClose`.
7. If `then` is not callable on a value, the resolver-element function itself
   handles wrapping (no separate fallback).

`built-ins/Promise/all/resolve-before-loop-exit.js` — the resolver invoked before
the loop completes must NOT trigger early settle. Today our impl may.

`Promise.all called on non-object` — we throw this when `this` is not the Promise
constructor; spec says throw if `this` is not an object (constructor check is more
permissive).

## Acceptance criteria

1. `built-ins/Promise/all/resolve-before-loop-exit.js` passes.
2. `built-ins/Promise/all/ctx-ctor.js` passes (custom Promise subclass).
3. `built-ins/Promise/allSettled/invoke-resolve-element-after-return.js` passes.
4. `built-ins/Promise/all/resolve-throws-iterator-return-null-or-undefined.js` passes
   (close iterator on throw).
5. `built-ins/Promise/race/ctx-non-promise.js` passes.
6. Pass-rate for these four methods rises from ~63% to ≥85%; **+50–70 net passes**.

## Files to modify

- `src/runtime.ts` — `__promise_all`, `__promise_allSettled`, `__promise_any`,
  `__promise_race` helpers — rewrite to spec.
- `src/codegen/expressions.ts` — `Promise.all(…)` call site — accept any `this`,
  not just `Promise`.

## Implementation Plan

### Root cause

The four host-imported helpers in runtime.ts are simplified versions of
`Array.prototype.map(item => Promise.resolve(item)).then(values => …)`. They:

- Don't accept a custom `this` (subclass) — fail when `Sub.all([…])` is called.
- Don't track per-element resolver state — multiple resolves on one element corrupt
  the values array.
- Don't close the iterator on throw — leak file handles / dangling iterator state.
- Don't validate `iterable` properly — `Promise.all(null)` should throw a clear
  TypeError, not "is not iterable".

### Approach

Rewrite each in `src/runtime.ts` per spec. For `__promise_all`:

```ts
__promise_all(thisArg, iterable) {
  // Spec step 1: IsConstructor check
  if (typeof thisArg !== 'function') {
    throw new TypeError("Promise.all called on non-constructor");
  }
  // step 2: NewPromiseCapability
  let resolveOuter, rejectOuter;
  const outer = new thisArg((res, rej) => { resolveOuter = res; rejectOuter = rej; });
  // step 3: GetIterator
  const it = iterable[Symbol.iterator]();
  if (!it || typeof it.next !== 'function') {
    rejectOuter(new TypeError("Promise.all argument is not iterable"));
    return outer;
  }
  // Per-element state
  const values = [];
  let remaining = 1;  // start at 1 to avoid early settle (decrement after loop)
  let i = 0;
  let abrupt = null;

  try {
    while (true) {
      let next;
      try { next = it.next(); }
      catch (e) { abrupt = e; break; }
      if (next.done) break;
      const idx = i++;
      values.push(undefined);
      remaining++;
      const resolveFn = (v) => {
        if (resolveFn._called) return;  // [[AlreadyCalled]]
        resolveFn._called = true;
        values[idx] = v;
        if (--remaining === 0) resolveOuter(values);
      };
      // Resolve to a thenable
      const p = thisArg.resolve(next.value);
      p.then(resolveFn, rejectOuter);
    }
  } finally {
    if (abrupt !== null) {
      // IteratorClose on abrupt
      try { if (typeof it.return === 'function') it.return(); } catch (_) {}
      rejectOuter(abrupt);
    } else if (--remaining === 0) {
      resolveOuter(values);
    }
  }
  return outer;
}
```

Key details:
- `[[AlreadyCalled]]` simulated by `resolveFn._called`.
- Initial `remaining = 1` then decrement after loop so empty iterables resolve
  with `[]` correctly.
- Iterator close on abrupt completion.

`__promise_allSettled`: similar but use `{status: 'fulfilled', value}` /
`{status: 'rejected', reason}` objects; never reject outer.

`__promise_any`: reject when ALL reject (with AggregateError); resolve on first
fulfill.

`__promise_race`: settle outer with first to settle.

### Codegen changes

In `src/codegen/expressions.ts`, the call site for `Promise.all(iter)`:

- Today: emit `local.get $iter; call $__promise_all` with NO `this` arg.
- Fix: emit `global.get $promise_ctor; local.get $iter; call $__promise_all`.

Or refactor `__promise_all(thisArg, iterable)` and bind via the call expression:
when source is `X.all(it)`, pass `X` as thisArg.

### Edge cases

- `Promise.all(null)` → throw TypeError synchronously (spec step 1) or reject?
  Spec says: throw inside the resolver; the result is a rejected promise. Our
  impl above achieves this via the try/catch.
- `Promise.all([1, 2, 3])` (non-thenables) → wraps via `thisArg.resolve()`; resolves
  with `[1, 2, 3]`.
- `class Sub extends Promise {}; Sub.all([…])` → `thisArg = Sub`; outer is a Sub.
- Iterator's `.next()` throws on iteration 3 → reject outer with thrown value;
  iterator's `.return()` is NOT called (spec step: AbruptCompletion in Phase 1
  doesn't IteratorClose for sync iterator).
- Result of `thisArg.resolve(next.value)`'s `.then` is poisoned getter → reject.

### Test262 sample

- `test262/test/built-ins/Promise/all/resolve-before-loop-exit.js`
- `test262/test/built-ins/Promise/all/ctx-ctor.js`
- `test262/test/built-ins/Promise/all/resolve-throws-iterator-return-null-or-undefined.js`
- `test262/test/built-ins/Promise/allSettled/invoke-resolve-element-after-return.js`
- `test262/test/built-ins/Promise/race/ctx-non-promise.js`
- `test262/test/built-ins/Promise/any/iterator-promise-resolve-throws-then.js`

### Estimated impact

+50–70 passes. §27.2 (Promise) climbs from 71% to ~80%.

## Implementation notes (senior-dev, 2026-05-08)

### Slice A landed

**Scope**: change host-helper signatures + delegate to native `Promise.all.call`.
~50 LoC across `runtime.ts`, `declarations.ts`, `calls.ts`, plus 4 unit tests.

The architect's rewrite-helpers-from-scratch plan was abandoned in favor of
**delegation**: native V8 already implements `[[AlreadyCalled]]` and
`IteratorClose` correctly when called via `Promise.all.call(C, iter)`.
Rewriting these in JS would re-implement spec details that the host engine
already handles.

Concrete changes:

1. **`src/runtime.ts:3273-3349`** — Promise aggregator host imports now take
   `(thisArg, iterable)`. `_resolveCtor` defaults `thisArg = null` to global
   `Promise`. `_toIterable` short-circuits JS arrays/iterables and falls back
   to `_vecToArray` for wasm vec inputs.

2. **`src/codegen/declarations.ts:982-998`** — pre-registration uses 2-arg
   signature for `Promise_all` / `Promise_race` / `Promise_allSettled` /
   `Promise_any`; resolve/reject keep the 1-arg signature.

3. **`src/codegen/expressions/calls.ts:3183-3291`** — direct `Promise.X(iter)`
   emits `(ref.null.extern, iter)` so runtime defaults to `globalThis.Promise`.
   New `Promise.X.call(thisArg, iter)` detection branch routes that pattern
   through the same import with explicit thisArg. (Note: `.call(...)` on
   `Promise.X` is also caught by the generic class-method-`.call` handler at
   `calls.ts:1377`, which IS reached first; my new branch at line 3251 is
   functional but partially shadowed in practice. Preserved for clarity.)

### Subclass support (Slice B) — blocked on #1382

Verified empirically that `class SubPromise extends Promise {}` compiles to a
wasm class struct that, when passed as externref, arrives on the JS side as
the proxy target object — NOT as a callable JS constructor. So
`thisArg = SubPromise` from the wasm side is currently un-construct-able by
`Promise.all.call(C, iter)`. The thisArg arrives as a non-null wasm proxy
that V8 rejects with "[object Object] is not a constructor".

`#1382` (Wasm closures not JS-callable from host imports) is the structural
blocker. Once that lands, the Slice A code already detects and forwards the
SubClass-receiver pattern; subclass-of-Promise tests will start passing
without further codegen work.

### Vec/iterable bridge fragility (pre-existing)

The `tests/promise-combinators.test.ts` "Promise.all with resolved values" /
"Promise.race with resolved values" tests fail on origin/main as well as
on this branch — verified by stashing my changes and re-running. Issue:
`Host.Source.getPromises()` returns a JS array, but when called from wasm
in JS-host-mode, the result is silently replaced by `__get_undefined` (see
WAT dump). Unrelated to #1368 — separate host-array-return bridge gap.

### Observed test262 impact

Cannot measure locally. CI will report. Expected:
- Tests using `Promise.all([…])` (no subclass): unchanged or slightly improved
  due to spec-compliant thisArg validation and `_toIterable` handling more
  input shapes.
- Tests using `Promise.all.call(SubClass, …)`: blocked on #1382 (no win
  until that lands).
- Tests verifying `[[AlreadyCalled]]` / `IteratorClose` semantics: should
  pass for the no-subclass case (we delegate to native Promise.all).

Estimated +5-15 net (much less than the issue's +50-70 — the delta would
come from #1382). Will re-scope or split based on CI numbers.
