---
id: 1064
title: "DataView bridge: subview metadata so bounds errors propagate"
status: done
created: 2026-04-11
updated: 2026-04-11
completed: 2026-04-28
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
language_feature: dataview
goal: ci-hardening
es_edition: multi
---
sprint: 40

# #1064 — DataView bridge: subview metadata so bounds errors propagate

## Status: Reverted 2026-04-11 — awaiting reapply + interaction bisect

**Original fix**: PR #107 (merge commit `fc4b06c8`, branch
`issue-1064-dataview-errors`, shipped 2026-04-11 19:14 UTC). dev-1053
rewrote the issue from the original "wrap in try/rethrow" sketch to a
sidecar model: track `byteOffset` / `byteLength` per DataView instance
so the runtime bridge reconstructs the correct subview with proper
bounds checking. 6/6 local tests pass + 11/11 `get*/index-is-out-of-range`
test262 cases flip from fail → pass.

**Why it was reverted**: PR #107 was part of the 3-PR interaction (#96 +
#100 + #107) that caused the 2026-04-11 CI baseline flip. Individual
revert of #107 alone (PR #113) did NOT recover the baseline — still
at 20,599. Only the combined 3-PR revert (PR #114) restored the healthy
22,157 baseline.

**Reapply sequence**: dev-1053 opened **PR #116** on 2026-04-11 ~21:00 UTC
cherry-picking commit `38afe7d1` onto post-rescue main (`65ea04b5`).
PR #116 is the empirical probe to test whether #107 alone, on a clean
baseline, is sufficient to trigger the flip. Expected outcomes documented
in the PR body.

**Full context**:
- `plan/log/investigations/2026-04-11-baseline-regression-bisect.md`
- `plan/issues/sprints/40/sprint.md`

**Work to redo if PR #116 is rejected**: restore the 5-file patch from
`git show 38afe7d1` (`src/codegen/expressions/new-super.ts`,
`src/runtime.ts`, `plan/issues/backlog/1064.md`, `tests/issue-1064.test.ts`,
plus the issue-file update) once the interaction is isolated and a
forward-fix is in place.

## Problem

Follow-up from #1056 (PR #90). The test262 bucket
`DataView/prototype/get*/index-is-out-of-range.js` fails ~11× because
`new DataView(buffer, byteOffset[, byteLength]).getXxx(idx)` silently returns
a value instead of throwing `RangeError` when `idx + elementSize > viewSize`.

## ECMAScript spec reference

- [§25.3.4 Properties of the DataView Prototype Object](https://tc39.es/ecma262/#sec-properties-of-the-dataview-prototype-object) — DataView methods must enforce bounds relative to the view's byteOffset and byteLength
- [§25.3.1.1 GetViewValue](https://tc39.es/ecma262/#sec-getviewvalue) — step 8: if getIndex + elementSize > viewSize, throw RangeError


## Root-cause analysis (dev-1053, 2026-04-11)

The original spec guessed "wrap native call in try/catch + rethrow". That's
wrong — nothing throws in the first place. Probed
`DataView/prototype/getUint16/index-is-out-of-range.js`:

```
// Bug case (fails the assertion):
//   var buffer = new ArrayBuffer(12);
//   var sample = new DataView(buffer, 10);  // view window: 2 bytes
//   sample.getUint16(1);                     // returned 0, no throw
//
// Control (passes — proves exception propagation already works):
//   var sample = new DataView(buffer, 0);
//   sample.getUint16(13);                    // correctly threw RangeError
```

The compiler's DataView constructor (`src/codegen/expressions/new-super.ts`
lines 2349–2472) validates `byteOffset`/`byteLength` at construction time and
throws `RangeError` if out of range, but then **returns the raw backing vec
struct unchanged** (line 2449). It never records the user-specified
`(byteOffset, byteLength)` window anywhere.

The runtime bridge in `__extern_method_call` (`src/runtime.ts` lines
1582–1602) then rebuilds a JS DataView:

```ts
const bytes = new Uint8Array(len);
for (let i = 0; i < len; i++) bytes[i] = dvGet(obj, i) & 0xff;
const realDv = new DataView(bytes.buffer);   // full 12 bytes, no offset/length
realDv.getUint16(1);                          // succeeds within 12-byte buffer
```

So the bridge sees a fresh 12-byte DataView where the user intended a 2-byte
view starting at offset 10, and `getUint16(1)` legitimately succeeds inside
the full buffer.

Wrapping `nativeFn.apply(realDv, args)` in try/catch is ineffective because
the native call does not throw.

## Fix — sidecar view metadata (rescoped by team-lead)

Track `(byteOffset, byteLength)` as sidecar metadata keyed on the buffer
struct, so the runtime bridge can reconstruct the correct subview when
dispatching native DataView methods.

### Runtime (`src/runtime.ts`)
1. Add module-level `WeakMap<object, {offset: number; length: number}>` — the
   key is the wasmGC vec struct (works because Wasm externrefs are JS objects
   and WeakMap accepts any non-primitive key).
2. Add host import handler `__dv_register_view(buf, offset, length)` that
   stores the metadata.
3. In the `__extern_method_call` DataView fallback, look up the metadata and
   build `new DataView(bytes.buffer, viewOffset, viewLength)` instead of the
   full-buffer DataView. For `set*` methods, only copy the bytes in the view
   window back through `__dv_byte_set`.

### Codegen (`src/codegen/expressions/new-super.ts`)
Rewrite the DataView `className === "DataView"` block so that:
1. `bufLocal`, `offsetF64`, `lenF64` locals are allocated uniformly regardless
   of `args.length`.
2. For `args.length >= 2`, the existing offset validation populates
   `offsetF64`; otherwise `offsetF64 = 0`.
3. For `args.length >= 3`, the existing length validation populates `lenF64`;
   otherwise `lenF64 = bufferByteLength - offsetF64` (read via
   `struct.get fieldIdx 0`).
4. After validation, register the view via `ensureLateImport +
   flushLateImportShifts` for `__dv_register_view: (externref, f64, f64) ->
   ()`, converting the struct to externref via `extern.convert_any`.
5. Restore the buffer struct on stack (unchanged).

## Known limitation

Multiple DataViews sharing the same underlying buffer struct overwrite each
other's metadata because the WeakMap key is the struct itself. The sample
test262 tests sequentially reassign `sample` and call `assert.throws`
synchronously, so the metadata is fresh at every assertion — this pattern is
unaffected. Interleaved DataView usage on the same buffer would be incorrect.
Properly fixing that requires wrapping DataView in its own struct, which is
a larger follow-up.

## Expected impact

~15 FAIL → PASS in `DataView/prototype/*/index-is-out-of-range.js`. The
`detached-buffer.js` bucket is a separate problem (our compiled
representation has no concept of buffer detachment) and is **not** addressed
by this fix.

## Test Results

Sample run after fix (dev-1053, 2026-04-11):

- `DataView/prototype/get*/index-is-out-of-range.js`: **11/11 PASS** (was 0/11)
  - getInt8, getUint8, getInt16, getUint16, getInt32, getUint32,
    getFloat16, getFloat32, getFloat64, getBigInt64, getBigUint64
- Happy-path reads/writes unaffected (return-values.js,
  return-values-custom-offset.js, return-value-clean-arraybuffer.js still
  pass)
- 6 issue-specific tests in `tests/issue-1064.test.ts` all pass
- Wider DataView prototype sample (80 tests across 16 methods): 55 PASS, 13
  pre-existing unrelated failures (length.js prototype-slot tests,
  not-a-constructor.js, immutable-buffer.js needing ArrayBuffer.transferToImmutable),
  1 set* aliasing test (setUint8/index-is-out-of-range.js — fails on
  Uint8Array/ArrayBuffer shared-buffer check, orthogonal to this fix)
- `detached-buffer.js` bucket (4 tests) **intentionally not addressed** —
  detachment has no representation in our compiled buffer model

## Source

Filed by `dev-1056` during self-merge triage of PR #90 (#1056). Rescoped by
`dev-1053` + `team-lead` after probing revealed the original diagnosis was
wrong.
