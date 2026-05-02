---
id: 1056
title: "DataView setUintN / setIntN / setFloatN instance methods missing"
status: done
created: 2026-04-11
updated: 2026-04-11
completed: 2026-04-14
priority: low
feasibility: medium
reasoning_effort: medium
task_type: bugfix
language_feature: test262-harvest-cluster
goal: test-infrastructure
es_edition: multi
---
# #1056 — DataView setUintN / setIntN / setFloatN instance methods missing

## Problem

`DataView.prototype.setUint8`, `setInt8`, `setUint16`, `setInt16`, `setUint32`, `setInt32`, `setFloat32`, `setFloat64`, `setBigInt64`, `setBigUint64`, `setFloat16` are missing — test helpers that set bytes before reading them fail with `setUint8 is not a function`. This blocks most `getXxx` tests from reaching their actual assertions.

## Evidence from harvest

- **Test count:** 89 tests currently failing with this pattern
- **Top path buckets:**
  - `7 test/built-ins/DataView/prototype/getBigUint64/*`
  - `7 test/built-ins/DataView/prototype/getFloat16/*`
  - `7 test/built-ins/DataView/prototype/getFloat32/*`
- **Top error messages:**
  - 35× `L41:3 setUint8 is not a function`
- **Sample test files:**
  - `test/built-ins/DataView/prototype/getBigUint64/to-boolean-littleendian.js`
  - `test/built-ins/DataView/prototype/getInt16/return-values-custom-offset.js`
  - `test/built-ins/DataView/prototype/getUint16/return-values.js`

## ECMAScript spec reference

- [§25.3.4 Properties of the DataView Prototype Object](https://tc39.es/ecma262/#sec-properties-of-the-dataview-prototype-object) — setUint8, setInt8, setUint16, setInt16, setUint32, setInt32, setFloat32, setFloat64 methods
- [§25.3.1.1 GetViewValue](https://tc39.es/ecma262/#sec-getviewvalue) — shared algorithm for typed read operations
- [§25.3.1.2 SetViewValue](https://tc39.es/ecma262/#sec-setviewvalue) — shared algorithm for typed write operations


## Root cause hypothesis

DataView was wired up for `get*` methods only in an earlier sprint; the `set*` mirror set was never installed in the prototype descriptor table.

## Fix

Implement the `set*` family on DataView.prototype symmetrically with the `get*` family. Share the byte-layout code paths. Related to closed issue #969 but the `set*` side was never completed — this is new work, not a regression fix.

## Expected impact

~89 FAIL directly, plus unblocks ~hundreds of downstream `get*` tests that rely on `set*` for setup.

## Key files

- src/codegen/expressions.ts (DataView method resolution)
- DataView runtime prototype install

## Source

Filed by `harvester-post-sprint-40-merge` 2026-04-11 against the post-merge Sprint 40 main baseline (`benchmarks/results/test262-current.jsonl`, 43,164 records).

## Implementation notes

Root cause was deeper than the issue described: **neither** getters nor setters
were wired — both failed with "X is not a function". The failure path was
`__make_iterable` in type-coercion, which converts any vec struct to a JS
array during extern.convert_any. For `i32_byte` vec structs (ArrayBuffer /
DataView backing), this destroyed the wasmGC struct identity, so the runtime
`__extern_method_call` fallback saw a plain JS array and returned
`setUint8/getUint8 is not a function` — even though the struct itself was
fine. Tests that looked like "setter missing" were actually "the receiver was
silently reshaped into a plain Array".

### Fix

1. `src/codegen/type-coercion.ts` — skip `__make_iterable` for `i32_byte` vec
   structs. ArrayBuffer/DataView are not JS-iterable anyway, and keeping the
   wasm struct identity lets the runtime recognize them as DataView receivers.
2. `src/codegen/index.ts` — emit three exports when an `i32_byte` vec type is
   registered: `__dv_byte_len`, `__dv_byte_get`, `__dv_byte_set`. These give
   the host raw access to the backing byte array.
3. `src/runtime.ts` — in `__extern_method_call`, when `fn` is undefined but
   the method name matches
   `(get|set)(Uint8|Int8|Uint16|Int16|Uint32|Int32|Float16|Float32|Float64|BigInt64|BigUint64)`
   and the receiver is a wasmGC struct, read the bytes via `__dv_byte_get`
   into a real Uint8Array, build a real DataView, invoke the native method,
   and for setters write the bytes back via `__dv_byte_set`.

### Known limitations (not in scope for #1056)

- `new DataView(buffer, byteOffset)` with non-zero `byteOffset` still shares
  the ArrayBuffer without offset tracking. Tests that call `new DataView(buf, 4)`
  will still fail — that's a separate structural fix (needs an offset field on
  the DataView wrapper).
- Detached-buffer semantics are not implemented.
- `BigInt64 / BigUint64` setters/getters currently route through the runtime
  bridge but the BigInt return/argument marshalling has not been revalidated
  against test262 — may need follow-up.
