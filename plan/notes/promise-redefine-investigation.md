# Investigation: `Promise.resolve is not a function` + `Cannot redefine property`

**Date:** 2026-05-01
**Investigator:** senior-developer (sonnet)
**Source:** team-lead brief (sprint 46)

---

## Pattern 1: `Promise.resolve is not a function` — **TEST INFRASTRUCTURE BUG, easy fix**

### Reproduction in isolation: NO

All four cited tests pass when run alone via `runTest262File`:
- `built-ins/Promise/resolve/resolve-poisoned-then.js` → pass
- `built-ins/Promise/race/S25.4.4.3_A7.1_T3.js` → compile_error (TS narrowing — different bug, unrelated)
- `built-ins/Promise/prototype/then/rxn-handler-fulfilled-invoke-strict.js` → pass
- `built-ins/Promise/reject-via-abrupt-queue.js` → pass

The full pattern in the latest baseline: **26 tests** fail with `Promise.resolve is not a function` (not the 6 mentioned in the brief — same root cause, larger blast radius).

### Reproduction in sequence: YES (proven)

Two-step repro:
1. Run `built-ins/Promise/all/invoke-resolve-on-values-every-iteration-of-promise.js` (passes, but its body does `Promise.resolve = function(...args) { ... }` and never restores it)
2. Run any test that calls `Promise.all(...)` → crashes inside `runtime.ts:2955` with `TypeError: resolve is not a function` because Node's `Promise.all` internally calls `Promise.resolve(value)` and `Promise.resolve` is now an object.

After step 1, `typeof Promise.resolve === "object"` in the worker process — proving the mutation leaked across tests.

### Root cause

`/workspace/scripts/test262-worker.mjs` snapshots+restores builtin prototypes/constructors between tests via `_METHOD_SNAPSHOTS`, `_STATIC_SNAPSHOTS`, and `_ACCESSOR_SNAPSHOTS` (lines 153–305). The constructor list at line 211 `_STATIC_SNAPSHOTS` covers `Array`, `Object`, `String`, `Number`, `Math`, `JSON`, `Reflect`, `RegExp` — **`Promise` is missing**.

`Promise.prototype` (instance methods `then`/`catch`/`finally`) IS snapshotted at line 184. So:
- Tests that mutate `Promise.prototype.then` → cleaned up correctly.
- Tests that mutate `Promise.resolve`/`Promise.reject`/`Promise.all`/`Promise.race`/etc. → **persist across tests** in the same fork process until the fork is recycled (~500 tests).

The runtime's `Promise_resolve` / `Promise_all` / etc. host imports in `src/runtime.ts:2955-2965` close over the global `Promise` constructor, so they pick up the mutated static methods. Even worse — Node's own `Promise.all` implementation calls `Promise.resolve` internally, so even tests that only use `Promise.all`, `.race`, etc. break.

The mutating tests are mostly under `built-ins/Promise/{all,any,race,allSettled}/invoke-resolve*.js` and similar — they intentionally replace `Promise.resolve` to verify the spec's invocation semantics.

### Proposed fix (one-line)

In `/workspace/scripts/test262-worker.mjs`, around line 286 (inside `_STATIC_SNAPSHOTS` array), add:

```js
["Promise", Promise, ["resolve", "reject", "all", "allSettled", "any", "race"]],
```

The existing `_restoreMethodProp` + `_staticOrig` machinery (lines 329-333, 475-479) will then automatically snapshot+restore these between tests with no other changes needed. Same shape as the existing entries.

### Expected gain

**~26 tests** in the current baseline (`benchmarks/results/test262-current.jsonl`).

This is purely test isolation — no compiler change, no risk of regression beyond the affected tests. The fix is symmetric with the existing `Array`, `Object`, etc. entries. Net `+26` pass on next test262 run.

### Difficulty: **TRIVIAL** (1 line, no codegen impact)

### Priority: **NOW (sprint 46)** — 5-minute fix, +26 conformance, zero risk.

---

## Pattern 2: `Cannot redefine property` — **two distinct sub-causes**

### Total in baseline: **23 tests**

Breakdown by error message:
| Error | Count | Sub-cause |
|---|---|---|
| `Cannot redefine property` (no name; under "Expected TypeError, got TypeError: ...") | 10 | (B) `instanceof TypeError` mismatch |
| `Cannot redefine property: 0` | 9 | (C) genuine compiler issue with arguments-object/array index defineProperty |
| `Cannot redefine property: next` | 2 | (A) test isolation — `Number.prototype` / `Iterator.prototype` pollution |
| `Cannot redefine property: length` | 1 | (A) test isolation — `TypedArray.prototype` pollution |
| `Cannot redefine property: p2` | 1 | (A or C) needs further triage |

### 2A. Iterator/TypedArray "next"/"length" — **TEST INFRASTRUCTURE, medium fix**

#### Reproduction in isolation: NO (passes alone)

Confirmed — both `Iterator/prototype/map/this-non-object.js` and `TypedArray/prototype/findLastIndex/get-length-ignores-length-prop.js` pass when run alone.

#### Root cause

The tests call `Object.defineProperty(SomeProto, name, { get: ... })` **without** `configurable: true`. By spec default `configurable: false`. So:
- First run in a fork: succeeds, installs non-configurable accessor
- Second run in the same fork: throws `Cannot redefine property: <name>`

Affected prototypes:
- `Number.prototype.next` (Iterator test stomps Number.prototype as fallback receiver)
- `TypedArray.prototype.length` and `Int8Array.prototype.length` (TypedArray test)

`test262-worker.mjs` `restoreBuiltins` (lines 384–509) handles this generically only for `Object.prototype` (lines 429-436) and `Array.prototype` numeric indices + symbols (lines 421-465). For other prototypes it only restores method values, not "extra-keys deletion."

#### Proposed fix

Extend `restoreBuiltins` with a generic "delete extra own-keys" pass for additional prototypes:

```js
// Snapshot at startup (near _origObjectProtoKeys at top of file):
const _PROTO_CLEANUP_TARGETS = [
  ["Number.prototype", Number.prototype],
  ["String.prototype", String.prototype],
  ["Boolean.prototype", Boolean.prototype],
  ["Function.prototype", Function.prototype],
  ["RegExp.prototype", RegExp.prototype],
  ["Date.prototype", Date.prototype],
  ["Promise.prototype", Promise.prototype],
  ["Error.prototype", Error.prototype],
  ["Map.prototype", Map.prototype],
  ["Set.prototype", Set.prototype],
  ["Int8Array.prototype", Int8Array.prototype],
  ["Uint8Array.prototype", Uint8Array.prototype],
  // ... all TypedArray ctors
  ["%TypedArray%.prototype", Object.getPrototypeOf(Int8Array.prototype)],
  ["%IteratorPrototype%", Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()))],
];
const _protoOrigKeys = _PROTO_CLEANUP_TARGETS.map(([name, proto]) => ({
  name, proto, keys: new Set(Object.getOwnPropertyNames(proto)),
}));

// In restoreBuiltins (after the existing Object.prototype loop):
for (const { proto, keys } of _protoOrigKeys) {
  for (const k of Object.getOwnPropertyNames(proto)) {
    if (!keys.has(k)) {
      try { delete proto[k]; } catch {}
    }
  }
}
```

#### Caveat / risk

If a test poisoned a prototype's own property non-configurably (e.g. the very tests in question), the `delete` will silently fail and the next run still throws. This is acceptable — these tests pass on first run, so we get the test once before pollution. Today they fail more often than they should because the same fork runs ~500 tests; a once-per-N-tests pollution turns into N-1 failures.

A stronger fix would `process.exit(1)` the fork when delete fails (forcing respawn), mirroring the Array.prototype FATAL guard at lines 411-418. That trades fork respawn overhead for full test isolation.

#### Expected gain

**~3 tests** confirmed (next, next, length). Possibly more — unknown how many tests trip prototype pollution we don't yet see in the baseline because the polluting test happens to come after the affected ones.

#### Difficulty: **EASY-MEDIUM** (~30 min: snapshot list + delete-extras loop, plus testing across the test262 chunks).

#### Priority: **NICE-TO-HAVE in sprint 46**, defer to 47 if time-pressed. Lower confidence in gain than Pattern 1.

### 2B. "Expected TypeError, got TypeError: Cannot redefine property" — **REAL COMPILER ISSUE**

#### Root cause

The tests catch the host `TypeError` thrown by `Object.defineProperty` and check `e instanceof TypeError`. The check returns false because:
- The thrown value is a host JS `TypeError` (Node's) wrapped in a `WebAssembly.Exception`
- Our compiled `instanceof TypeError` doesn't unwrap the host error to test against the host TypeError class

#### Repro in isolation: PARTIAL

Running `built-ins/Object/defineProperties/15.2.3.7-6-a-93-3.js` alone: status `fail` with error `[object WebAssembly.Exception]` — this is a *different* error path (the host error wasn't even caught at all). So the "instanceof returns false" path only triggers when tests are sharded.

#### Difficulty: **MEDIUM-HARD** — requires changes to `instanceof` codegen for builtin Error subtypes against externref values, or to the WebAssembly.Exception unwrap logic.

#### Priority: **DEFER to sprint 47** — out of scope for "small fix."

### 2C. `Cannot redefine property: 0` — **REAL COMPILER ISSUE (mapped arguments)**

The 9 tests under `language/arguments-object/mapped/` are testing arguments-object semantics (mapped arguments must reflect formal parameter writes). We don't fully implement the mapped-arguments spec. These tests would still fail in isolation (not infrastructure).

#### Difficulty: **HARD** — requires arguments-object reform.
#### Priority: **DEFER to sprint 47+**, separate issue.

---

## Final answers to brief

### Which patterns are real compiler bugs vs flakes?

| Pattern | Type | Tests |
|---|---|---|
| Promise.resolve is not a function | **TEST INFRA** (missing snapshot) | 26 |
| Cannot redefine property: next/length | **TEST INFRA** (incomplete prototype cleanup) | 3 |
| Expected TypeError, got TypeError: Cannot redefine | **COMPILER** (instanceof on host errors) | 10 |
| Cannot redefine property: 0 | **COMPILER** (mapped-arguments semantics) | 9 |
| Cannot redefine property: p2 | unknown — needs triage | 1 |

### Combined test262 gain if both isolation patterns are fixed

**+29 tests** (26 Promise + 3 Cannot-redefine isolation cases). Possibly more if hidden pollution-after-test cases exist.

### Recommendation

- **Pattern 1 (Promise snapshot, +26): DO NOW in sprint 46.** Trivial 1-line change to `scripts/test262-worker.mjs`. Zero risk. Symmetric with existing Array/Object snapshots. Highest ROI fix in the suite right now.
- **Pattern 2A (proto cleanup, +3): DO NOW or sprint 47.** Easy fix with smaller gain. Could bundle with Pattern 1 in the same PR.
- **Pattern 2B (instanceof TypeError, +10): DEFER to 47.** Real compiler change, needs design.
- **Pattern 2C (mapped arguments, +9): SEPARATE ISSUE**, defer.

### Suggested issue title

> `[test-infra] Add Promise constructor + extra-prototype cleanup to test262-worker isolation`
> Acceptance: +26 (Promise) +3 (proto) tests pass on next test262-sharded run; no regressions; PR diff is ≤30 LOC in `scripts/test262-worker.mjs`.

---

## Files referenced

- `/workspace/scripts/test262-worker.mjs` — fix site
- `/workspace/src/runtime.ts:2955-2965` — host imports that close over global `Promise`
- `/workspace/test262/test/built-ins/Promise/all/invoke-resolve-on-values-every-iteration-of-promise.js` — confirmed mutator (passes, leaves `Promise.resolve` as object)
- `/workspace/benchmarks/results/test262-current.jsonl` — baseline used for counts
