---
id: 1160
title: "Array.from codegen error — test262-worker prototype poisoning leak (730 tests)"
status: done
created: 2026-04-21
updated: 2026-04-28
completed: 2026-04-28
priority: high
feasibility: medium
reasoning_effort: medium
task_type: bugfix
language_feature: array-builtins
goal: spec-completeness
closed: 2026-04-23
pr: 7
net_improvement: 578
---
## Implementation Summary

Root cause: `restoreBuiltins()` in `scripts/test262-worker.mjs` used plain `=` assignment to restore `Array.prototype[Symbol.iterator]`, which silently no-ops when a test had poisoned the property via `Object.defineProperty` with `writable:false`. Subsequent compiler calls to `Array.from(nodeArray)` would then see a non-callable `@@iterator` and throw the codegen error.

Fix: captured the original property descriptor via `Object.getOwnPropertyDescriptor` at startup, and added `_restoreMethodProp()` which first tries value assignment (cheap, preserves IC caches) then falls back to `Object.defineProperty` with the captured descriptor when assignment silently fails. Also added `_snapshotDescriptor()` for the full method/static snapshots so all future restores can retry via `defineProperty` if needed.

Added `tests/issue-1160.test.ts` (92 lines) covering the poisoning + restore cycle. Merged PR #7 (2026-04-23), +578 net tests.

## Follow-up: residual ~452 errors (2026-04-26)

After PR #7, CI continued to show ~187–452 `%Array%.from requires…` errors per
run, with the same V8 message but appearing as drift across unrelated PRs (#27,
#31). PR #34 closed the symptom but had a wrong fix (regressing 559 tests).
Re-investigation found a second, independent root cause:

**Bug**: `_safeSet(obj, key, val)` in `src/runtime.ts` had a code path that
re-mapped numeric keys 1–14 onto well-known Symbols (1 → `Symbol.iterator`,
2 → `Symbol.hasInstance`, …, 3 → `Symbol.toPrimitive`, …). The intent was to
support `obj[Symbol.iterator] = X` from compiled Wasm where the compiler
emits the symbol as `i32.const 1`. **But the branch was applied
unconditionally**, including to host JS arrays. So a perfectly ordinary test
statement like

```js
var srcArr = new Array(10);
srcArr[1] = undefined; // intended: index assignment
```

got rewritten by `_safeSet` to `srcArr[Symbol.iterator] = undefined`. Under
the accumulated state of a long-running fork, that mis-routed assignment
could leak through host-side proxy bookkeeping onto `Object.prototype`,
leaving `Object.prototype[Symbol.iterator] = <number>` for every subsequent
test's compile. The compiler's own `Array.from({length: argCount}, fn)` call
in `src/codegen/declarations.ts:1136` then trips V8's spec check and throws
the verbatim error, surfacing as `L0:0 Codegen error:`.

The reproducer (`.tmp/repro-1160-massive.mjs`): run 1500 tests through one
worker, observe 20+ `%Array%.from` compile_errors starting at test #155
(`built-ins/Array/prototype/map/15.4.4.19-8-c-i-11.js`), traced via debug
instrumentation in the worker's `Array.from` wrapper. With the fix: 0 errors.

**Fix** (in `src/runtime.ts`): gate the symbol-ID remapping by
`_isWasmStruct(obj)` — mirroring the pre-existing guard in `_safeGet`.
Numeric indices on host JS objects/arrays are now treated as numeric
indices, never as Symbol IDs.

**Defence-in-depth** (in `scripts/test262-worker.mjs/restoreBuiltins`):

1. Snapshot the original Symbol-keyed properties on `Object.prototype` and
   `Array.prototype` at module load (`_origObjectProtoSymbols`,
   `_origArrayProtoSymbols`).
2. After every test, delete any Symbol-keyed properties that weren't there
   originally — covers any future poisoning vector we haven't anticipated.
3. Extend the FATAL guard so non-configurable Symbol-keyed pollution on
   `Object.prototype` exits the fork for restart (parent respawns).

Added a new test in `tests/issue-1160.test.ts` asserting the contract:
`Object.getOwnPropertySymbols(Object.prototype).length === 0` — i.e. no
Symbol-keyed property leaks onto `Object.prototype` from numeric assignments.

Verified: 1500-test sequential repro that previously produced 20+
`%Array%.from` errors now produces 0.

# #1160 — `%Array%.from` codegen error (~730 tests)

## Problem

730 test262 failures report (full message):

```
L1:0 Codegen error: %Array%.from requires that the property of the first
argument, items[Symbol.iterator], when exists, be a function
```

Failures are spread across array method tests: `forEach`, `lastIndexOf`, `map`,
`indexOf`, `findIndex`, `resizable-buffer*`, etc.

## Root cause (identified)

The error is **not** in compiler codegen. It is V8's runtime error for
`Array.from(x)` when `x[Symbol.iterator]` exists but is not callable.

Where it surfaces: the compiler's own `Array.from(nodeArray)` calls inside
the fork worker process. The nodeArray inherits `[Symbol.iterator]` from
`Array.prototype`, so if a previous test poisoned that slot, every
subsequent test's compile throws the V8 error, which the compiler's
outer `try { … } catch (e) { reportErrorNoNode(ctx, "Codegen error: " +
e.message) }` wraps into a fake `L1:0 Codegen error` diagnostic.

How `Array.prototype[Symbol.iterator]` gets poisoned across tests:

1. A test262 test does `Object.defineProperty(Array.prototype,
Symbol.iterator, { value: <non-function>, writable: false, … })` — this
   is a legal way to test iterator-related spec behaviour.
2. `scripts/test262-worker.mjs#restoreBuiltins` tries to restore via plain
   `Array.prototype[Symbol.iterator] = _origArrayIterator`.
3. Assignment silently no-ops on a non-writable descriptor (or throws in
   strict mode and is caught by a `try { } catch {}`).
4. The poison persists into the next test's compile → `Array.from` throws →
   caught by codegen wrapper → reported as `L1:0 Codegen error`.

Demo (Node.js):

```js
Object.defineProperty(Array.prototype, Symbol.iterator, { value: 42, writable: false });
Array.prototype[Symbol.iterator] = [].values; // silently fails
Array.from([1, 2, 3]);
// → "%Array%.from requires that the property of the first argument,
//    items[Symbol.iterator], when exists, be a function"
```

This also explains the observed variability across runs (816 → 461 → 731 → …
count) — the failure count tracks how many tests happen to be sharded into
the same fork as the poisoning test, after it, before the next fork restart.

## Fix

`scripts/test262-worker.mjs`:

1. **Capture original descriptors** (not just values) for
   `Array.prototype[Symbol.iterator]` and every restored method /
   static-constructor method in `_METHOD_SNAPSHOTS` / `_STATIC_SNAPSHOTS`.
2. **Two-stage restore in `restoreBuiltins`**: try `=` first (hot path,
   no IC disturbance); when the value is still wrong after the assignment,
   fall back to `Object.defineProperty` with the captured descriptor
   (cold path, but needed to escape non-writable poison).
3. **Early FATAL + exit-for-restart** if `Array.prototype[Symbol.iterator]`
   cannot be restored (descriptor was non-configurable). This runs BEFORE
   the rest of `restoreBuiltins`'s `for..of` loops because those loops
   themselves would otherwise throw `T is not iterable`.
4. **Pre-compile `restoreBuiltins()`** in `doCompile` as defence-in-depth
   for rare worker-interruption scenarios where `postCompileCleanup` didn't
   run for the previous test.

Covered by `tests/issue-1160.test.ts` — exercises both the writable:true
poisoning path and the defineProperty / writable:false path.

## Test Results

- `tests/issue-1160.test.ts`: 2/2 pass (new file).
- Standalone verification script (`/tmp/verify-1160.mjs`) exercises the
  worker's `restoreBuiltins` in isolation: 4/4 poisoning scenarios restore
  correctly (writable:true value assign, writable:false defineProperty
  poison, Array.from poisoning, Array.prototype[Symbol.iterator]
  poisoning).
- Full test262 pass rate change will be measured by CI on the PR.

## Acceptance criteria

- 730 → 0 `%Array%.from requires that the property` errors in CI test262 run.
- No regressions in `tests/equivalence.test.ts`.
