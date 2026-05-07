---
id: 1350
sprint: 50
title: "spec gap: ArrayBuffer resizable + TypedArray detached-buffer guards (100 + 39 test262 fails)"
status: ready
created: 2026-05-08
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: runtime
language_feature: typedarray
goal: spec-completeness
parent: 1328
---
# #1350 — ArrayBuffer.resize / detached-buffer guards on TypedArray methods

## Problem

`built-ins/ArrayBuffer`: **87 / 196 pass (44.4%) — 100 fails (44 wasm_compile, 36 assertion_fail,
9 other, 5 null_deref, 1 type_error)**.
`built-ins/DataView`: **410 / 561 pass (73.1%) — 26 runtime_error among 112 fails**.
`built-ins/Uint8Array`: **31 / 68 pass (45.6%) — 37 fails**.

Spec §25.1 (ArrayBuffer): ArrayBuffer can be resizable (constructor accepts `{maxByteLength}`) or
fixed-length. Detached buffers throw TypeError on every read/write/access.

Spec §23.2 (TypedArray): every prototype method must check IsDetachedBuffer at the start, throw
TypeError if detached. ArrayBuffer.transfer detaches the source.

The 44 wasm_compile errors in ArrayBuffer suggest the ResizableArrayBuffer constructor signature
isn't recognized — the typed-codegen path gets a wrong arity.

## Acceptance criteria

1. `built-ins/ArrayBuffer/prototype/resize/length.js` passes.
2. `built-ins/ArrayBuffer/transfer/detaches-source-buffer.js` passes.
3. `built-ins/TypedArray/prototype/copyWithin/detached-buffer-throws.js` passes.
4. `built-ins/DataView/prototype/getInt32/detached-buffer-throws.js` passes.
5. Pass-rate for `built-ins/ArrayBuffer` rises from 44% to ≥75%.

## Files to modify

- `src/runtime.ts` — `__arraybuffer_*` host imports
- `src/codegen/registry/typedarray.ts` — detached-buffer guards on every prototype method

## Implementation Plan

### Root cause

ResizableArrayBuffer is newer (ES2024); our codegen registry doesn't have an overload for the
options-object constructor `new ArrayBuffer(byteLength, {maxByteLength})`. Type-inference picks
the wrong overload and emits a wasm_compile-failing call.

Detached-buffer guards: each TypedArray method needs a prologue:
```
if (IsDetachedBuffer(this[[ViewedArrayBuffer]])) throw TypeError
```
We've inlined the methods without this guard.

### Approach

1. **Resizable**: add an options-object constructor variant. Store `maxByteLength` in the
   ArrayBuffer struct; `.resize(newLength)` updates `byteLength` if `<= maxByteLength`, throws
   RangeError otherwise.
2. **transfer**: implement by allocating a new buffer, copying data, marking source detached.
3. **Detached guards**: extend the codegen registry so every TypedArray method emits a detached
   check at entry. Add `IsDetachedBuffer` host import that returns 1/0.

### Edge cases

- `transfer()` with no argument → use source's byteLength.
- `transfer(newLen)` where newLen > source: zero-pad.
- Detached check must run even for length-0 access (e.g. `view.getInt8(0)` on a 0-length detached buffer).
- DataView: detached check separate from ArrayBuffer detached.

### Test262 sample

- `test262/test/built-ins/ArrayBuffer/prototype/resize/length.js`
- `test262/test/built-ins/ArrayBuffer/transfer/detaches-source-buffer.js`
- `test262/test/built-ins/TypedArray/prototype/copyWithin/detached-buffer-throws.js`
