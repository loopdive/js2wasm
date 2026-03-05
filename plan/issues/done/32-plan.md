# Capacity-Based Array Representation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace bare WASM GC arrays with struct wrappers `{length, data}` supporting capacity-based growth, turning push from O(n) to amortized O(1).

**Architecture:** Every TS `T[]` becomes a WASM GC struct with `(field $length (mut i32))` and `(field $data (mut (ref $__arr_T)))`. Capacity is implicit via `array.len(data)`. Growth uses 2x doubling (min 4). All bulk copies use the `array.copy` instruction instead of element-by-element loops.

**Tech Stack:** TypeScript compiler (src/codegen), WASM GC binary format (src/emit), vitest tests.

---

## Task 1: Add `array.copy` and `array.fill` to IR and emitters

**Files:**
- Modify: `src/ir/types.ts:154-160` (Instr union)
- Modify: `src/emit/opcodes.ts:80-102` (GC opcodes)
- Modify: `src/emit/binary.ts:617-651` (binary encoder)
- Modify: `src/emit/wat.ts:274-285` (WAT text encoder)

**Step 1: Add IR instruction variants**

In `src/ir/types.ts`, add after the `array.len` line (line 160):

```ts
  | { op: "array.copy"; dstTypeIdx: number; srcTypeIdx: number }
  | { op: "array.fill"; typeIdx: number }
```

**Step 2: Add GC opcode constants**

In `src/emit/opcodes.ts`, add to the `GC` object (after `array_len: 0x0f`):

```ts
  array_fill: 0x10,
  array_copy: 0x11,
```

**Step 3: Add binary emission**

In `src/emit/binary.ts`, add cases after the `array.len` case (after line 651):

```ts
    case "array.copy":
      enc.byte(GC.prefix);
      enc.byte(GC.array_copy);
      enc.u32(instr.dstTypeIdx);
      enc.u32(instr.srcTypeIdx);
      break;
    case "array.fill":
      enc.byte(GC.prefix);
      enc.byte(GC.array_fill);
      enc.u32(instr.typeIdx);
      break;
```

**Step 4: Add WAT text emission**

In `src/emit/wat.ts`, add cases after the `array.len` formatting:

```ts
    case "array.copy":
      return `array.copy ${instr.dstTypeIdx} ${instr.srcTypeIdx}`;
    case "array.fill":
      return `array.fill ${instr.typeIdx}`;
```

**Step 5: Run tests**

Run: `npx vitest run`
Expected: All 198 existing tests still pass (no behavior change yet).

**Step 6: Commit**

```
feat: add array.copy and array.fill IR instructions and emitters
```

---

## Task 2: Add `vecTypeMap` and `getOrRegisterVecType` to codegen context

**Files:**
- Modify: `src/codegen/index.ts:60-94` (CodegenContext interface)
- Modify: `src/codegen/index.ts:135-175` (context initialization — find where `arrayTypeMap` is initialized)
- Modify: `src/codegen/index.ts:935-950` (near `getOrRegisterArrayType`)

**Step 1: Add `vecTypeMap` field to CodegenContext**

In `src/codegen/index.ts`, add to the `CodegenContext` interface near `arrayTypeMap`:

```ts
  /** Maps element kind → vec struct type index (wrapping the raw array) */
  vecTypeMap: Map<string, number>;
```

Initialize it in the context creation (where `arrayTypeMap: new Map()` is):

```ts
  vecTypeMap: new Map(),
```

**Step 2: Add `getOrRegisterVecType` function**

Add after `getOrRegisterArrayType` (after line 950):

```ts
export function getOrRegisterVecType(
  ctx: CodegenContext,
  elemKind: string,
  elemTypeOverride?: ValType,
): number {
  const existing = ctx.vecTypeMap.get(elemKind);
  if (existing !== undefined) return existing;

  const arrTypeIdx = getOrRegisterArrayType(ctx, elemKind, elemTypeOverride);
  const vecIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: `__vec_${elemKind}`,
    fields: [
      { name: "length", type: { kind: "i32" }, mutable: true },
      { name: "data", type: { kind: "ref", typeIdx: arrTypeIdx }, mutable: true },
    ],
  });
  ctx.vecTypeMap.set(elemKind, vecIdx);
  return vecIdx;
}
```

**Step 3: Add helper to get array type index from vec type index**

```ts
export function getArrTypeIdxFromVec(ctx: CodegenContext, vecTypeIdx: number): number {
  const vecDef = ctx.mod.types[vecTypeIdx];
  if (!vecDef || vecDef.kind !== "struct") throw new Error("not a vec type");
  const dataField = vecDef.fields[1];
  if (dataField.type.kind !== "ref") throw new Error("vec data field not ref");
  return dataField.type.typeIdx;
}
```

**Step 4: Run tests**

Run: `npx vitest run`
Expected: All tests pass (new code not wired up yet).

**Step 5: Commit**

```
feat: add vecTypeMap and getOrRegisterVecType for capacity arrays
```

---

## Task 3: Switch `resolveWasmType` to return vec struct type for arrays

**Files:**
- Modify: `src/codegen/index.ts:959-970` (resolveWasmType array branch)

**Step 1: Change the array branch**

In `resolveWasmType`, replace the array branch (lines ~959-970). Instead of calling `getOrRegisterArrayType` directly, call `getOrRegisterVecType`:

```ts
    // Array<T> — MUST check before isExternalDeclaredClass (Array is declared in lib)
    if (sym?.name === "Array" && tsType.typeArguments?.length) {
      const elemTsType = tsType.typeArguments[0];
      const elemWasm = resolveWasmType(ctx, elemTsType);
      const elemKind =
        elemWasm.kind === "ref" || elemWasm.kind === "ref_null"
          ? `ref_${(elemWasm as { typeIdx: number }).typeIdx}`
          : elemWasm.kind;
      const vecIdx = getOrRegisterVecType(ctx, elemKind, elemWasm);
      return { kind: "ref_null", typeIdx: vecIdx };
    }
```

NOTE: This will break ALL array tests because every downstream operation still expects the typeIdx to point to an array type, not a struct type. That's expected — the following tasks fix each call site.

**Step 2: Run tests to confirm breakage**

Run: `npx vitest run tests/arrays-enums.test.ts`
Expected: FAIL — confirms the switch is active.

**Step 3: Commit**

```
refactor: resolveWasmType returns vec struct type for arrays (breaks tests — WIP)
```

---

## Task 4: Update `resolveArrayInfo` and add vec-aware helpers

This is the central helper used by ALL array method compilers. Fixing it first means less duplication in later tasks.

**Files:**
- Modify: `src/codegen/expressions.ts:3117-3126` (resolveArrayInfo)

**Step 1: Rewrite `resolveArrayInfo`**

The function currently returns `{ typeIdx, elemType }` where typeIdx is the array type. Change it to also return the vec struct type index. Since the type is now a vec struct, we need to dig into its data field to find the underlying array type.

```ts
function resolveArrayInfo(
  ctx: CodegenContext,
  tsType: ts.Type,
): { vecTypeIdx: number; arrTypeIdx: number; elemType: ValType } | null {
  const wasmType = resolveWasmType(ctx, tsType);
  if (wasmType.kind !== "ref" && wasmType.kind !== "ref_null") return null;
  const vecTypeIdx = (wasmType as { typeIdx: number }).typeIdx;
  const vecDef = ctx.mod.types[vecTypeIdx];
  if (!vecDef || vecDef.kind !== "struct") return null;
  // Validate this is a vec struct (has "data" field pointing to an array type)
  if (vecDef.fields.length < 2) return null;
  const dataField = vecDef.fields[1];
  if (dataField.type.kind !== "ref") return null;
  const arrTypeIdx = dataField.type.typeIdx;
  const arrDef = ctx.mod.types[arrTypeIdx];
  if (!arrDef || arrDef.kind !== "array") return null;
  return { vecTypeIdx, arrTypeIdx, elemType: arrDef.element };
}
```

**Step 2: Update all callers**

Every place that calls `resolveArrayInfo` and uses `typeIdx` needs updating to use `arrTypeIdx` and `vecTypeIdx` appropriately. This is done in tasks 5-10 below, but update the call sites in `compileArrayMethodCall` first (the dispatcher, lines 3153-3226):

- Change the destructured `{ typeIdx, elemType }` to `{ vecTypeIdx, arrTypeIdx, elemType }`
- Pass `vecTypeIdx`, `arrTypeIdx`, and `elemType` to each method compiler
- Update the module global proxy to use the vec struct type for its temp local

**Step 3: Run tests**

Run: `npx vitest run tests/arrays-enums.test.ts`
Expected: Still failing (method compilers not updated yet).

**Step 4: Commit**

```
refactor: resolveArrayInfo returns vec and arr type indices
```

---

## Task 5: Update array literals to create vec structs

**Files:**
- Modify: `src/codegen/expressions.ts:2851-2994` (compileArrayLiteral)

**Step 1: Rewrite empty array literal**

For `const arr: number[] = []`, instead of `array.new_fixed $arr 0`, emit:

```
i32.const 0                         ;; length = 0
array.new_default $arrTypeIdx 0     ;; empty backing array (capacity 0)
  — wait, array.new_default takes size from stack
i32.const 0
array.new_default $arrTypeIdx       ;; data = empty array
struct.new $vecTypeIdx              ;; wrap in vec struct
```

Note: `struct.new` pops fields in declaration order (length first, then data), but the WASM spec pops in reverse stack order. Actually, `struct.new` expects fields on the stack in order: field 0 (length), then field 1 (data). So:

```
i32.const 0                     ;; length
i32.const 0                     ;; capacity (for array.new_default)
array.new_default $arrTypeIdx   ;; data (ref $arr)
struct.new $vecTypeIdx          ;; struct { length=0, data=[] }
```

**Step 2: Rewrite non-spread array literal**

For `[10, 20, 30]`, compile elements onto stack, create backing array, then wrap:

```
;; push elements onto stack
<compile elem0>
<compile elem1>
<compile elem2>
array.new_fixed $arrTypeIdx 3    ;; create backing array with 3 elements
local.set $tmpData               ;; store data temporarily
i32.const 3                      ;; length = 3
local.get $tmpData               ;; data
struct.new $vecTypeIdx           ;; wrap
```

Actually — `struct.new` consumes fields from the stack in order. So we need length first, then data. But `array.new_fixed` gives us data, which needs to be field 1. We need a temp local or reorder:

```
<compile elem0>
<compile elem1>
<compile elem2>
array.new_fixed $arrTypeIdx 3    ;; → (ref $arr) on stack
local.set $tmpData
i32.const 3                      ;; field 0: length
local.get $tmpData               ;; field 1: data
struct.new $vecTypeIdx
```

Allocate a temp local of type `(ref $arrTypeIdx)` for this.

**Step 3: Rewrite spread array literal**

For `[...a, ...b]`, the existing code already uses `array.new_default` and fills via loop. Change to:
- Compute total length (same as before)
- Create backing array with `array.new_default` of total length (same as before)
- Fill elements using same loop (but now target the backing array)
- Wrap result: push length, push data ref, `struct.new`

**Step 4: Fix the type detection**

The function currently uses `getOrRegisterArrayType` to determine the type. Change to `getOrRegisterVecType`. The function also looks up the context type for empty arrays — make sure that path also returns a vec type.

**Step 5: Run tests**

Run: `npx vitest run tests/arrays-enums.test.ts`
Expected: "array literal and index read" — still fails (element access not updated yet).

**Step 6: Commit**

```
refactor: array literals create vec structs
```

---

## Task 6: Update element access, element assignment, and `.length`

**Files:**
- Modify: `src/codegen/expressions.ts:2679-2729` (compileElementAccess)
- Modify: `src/codegen/expressions.ts:1369-1394` (compileElementAssignment)
- Modify: `src/codegen/expressions.ts:2571-2581` (compilePropertyAccess .length)

**Step 1: Update `compileElementAccess`**

Currently:
```
<array ref>       ;; (ref $arr)
<index as i32>
array.get $arr
```

Change to:
```
<vec ref>          ;; (ref $vec)
struct.get $vec 1  ;; get data field → (ref $arr)
<index as i32>
array.get $arr
```

The function currently validates `typeDef.kind === "array"`. Change it to:
1. If `typeDef.kind === "struct"` and it's a vec type: extract arrTypeIdx from field 1, use that
2. Keep the old path as fallback for non-vec struct element access (if any)

**Step 2: Update `compileElementAssignment`**

Same pattern. Currently:
```
<array ref>
<index as i32>
<value>
array.set $arr
```

Change to:
```
<vec ref>
struct.get $vec 1   ;; get data
<index as i32>
<value>
array.set $arr
```

**Step 3: Update `.length` in `compilePropertyAccess`**

Currently (lines 2571-2581):
```
<array ref>
array.len
f64.convert_i32_s
```

Change to:
```
<vec ref>
struct.get $vec 0   ;; get length field
f64.convert_i32_s
```

Note: use `struct.get` with fieldIdx=0 (the length field), NOT `array.len` on the data. This is important because after `pop()`, the logical length is less than `array.len(data)`.

**Step 4: Run tests**

Run: `npx vitest run tests/arrays-enums.test.ts`
Expected: All 5 array tests should PASS now (literal, indexing, length, assignment, loop).

**Step 5: Commit**

```
feat: element access, assignment, and .length use vec struct
```

---

## Task 7: Update array destructuring

**Files:**
- Modify: `src/codegen/statements.ts:250-300` (compileArrayDestructuring)

**Step 1: Update type validation**

The function currently checks `typeDef.kind !== "array"`. Change to check for vec struct:

```ts
const typeDef = ctx.mod.types[typeIdx];
if (!typeDef || typeDef.kind !== "struct") {
  // error...
  return;
}
// Extract underlying array type from vec struct
const dataField = typeDef.fields[1];
if (!dataField || dataField.type.kind !== "ref") {
  // error...
  return;
}
const arrTypeIdx = dataField.type.typeIdx;
const arrDef = ctx.mod.types[arrTypeIdx];
if (!arrDef || arrDef.kind !== "array") {
  // error...
  return;
}
const elemType = arrDef.element;
```

**Step 2: Update element extraction**

Currently:
```ts
fctx.body.push({ op: "local.get", index: tmpLocal });
fctx.body.push({ op: "i32.const", value: i });
fctx.body.push({ op: "array.get", typeIdx });
```

Change to:
```ts
fctx.body.push({ op: "local.get", index: tmpLocal });
fctx.body.push({ op: "struct.get", typeIdx, fieldIdx: 1 }); // get data
fctx.body.push({ op: "i32.const", value: i });
fctx.body.push({ op: "array.get", typeIdx: arrTypeIdx });
```

**Step 3: Run tests**

Run: `npx vitest run`
Expected: Destructuring tests pass. Check spread-rest tests too: `npx vitest run tests/spread-rest.test.ts`

**Step 4: Commit**

```
feat: array destructuring uses vec struct
```

---

## Task 8: Replace `emitArrayCopyLoop` with `array.copy`

**Files:**
- Modify: `src/codegen/expressions.ts:3229-3277` (emitArrayCopyLoop)

**Step 1: Rewrite `emitArrayCopyLoop`**

Replace the entire function body with a single `array.copy` instruction:

```ts
function emitArrayCopy(
  fctx: FunctionContext,
  arrTypeIdx: number,
  dstArr: number,   // local holding dst array ref
  dstOffset: number, // local holding i32 dst offset
  srcArr: number,   // local holding src array ref
  srcOffset: number, // local holding i32 src offset
  count: number,    // local holding i32 count
): void {
  fctx.body.push({ op: "local.get", index: dstArr });
  fctx.body.push({ op: "local.get", index: dstOffset });
  fctx.body.push({ op: "local.get", index: srcArr });
  fctx.body.push({ op: "local.get", index: srcOffset });
  fctx.body.push({ op: "local.get", index: count });
  fctx.body.push({ op: "array.copy", dstTypeIdx: arrTypeIdx, srcTypeIdx: arrTypeIdx });
}
```

Signature change: the old function takes `typeIdx` + `elemType`. The new one only needs `arrTypeIdx`. Callers need to be updated to pass individual locals for offsets/counts rather than inline i32.const + expressions. Adapt callers as needed — some pass literal 0 for offsets, which should still be stored in a local or emitted as `i32.const 0`.

Actually, `array.copy` takes values from the stack, not locals. So we can simplify:

```ts
// Emit: array.copy $dst $src
// Stack: [dstArr, dstOffset, srcArr, srcOffset, count] → []
function emitArrayCopy(
  fctx: FunctionContext,
  arrTypeIdx: number,
): void {
  fctx.body.push({ op: "array.copy", dstTypeIdx: arrTypeIdx, srcTypeIdx: arrTypeIdx });
}
```

And at each call site, push the 5 stack values before calling this. This is simpler and avoids extra local allocations.

**Step 2: Update all callers**

Each caller currently does:
```ts
emitArrayCopyLoop(fctx, typeIdx, elemType, dst, dstOff, src, srcOff, count);
```

Change to push 5 values on stack then emit `array.copy`:
```ts
fctx.body.push({ op: "local.get", index: dst });
fctx.body.push({ op: "i32.const", value: 0 }); // or local.get dstOff
fctx.body.push({ op: "local.get", index: src });
fctx.body.push({ op: "i32.const", value: 0 }); // or local.get srcOff
fctx.body.push({ op: "local.get", index: count });
fctx.body.push({ op: "array.copy", dstTypeIdx: arrTypeIdx, srcTypeIdx: arrTypeIdx });
```

The old `emitArrayCopyLoop` function and its helper locals can be removed entirely.

**Step 3: Run tests**

Run: `npx vitest run`
Expected: Tests that still use the old array copy paths may fail — that's fine, they're rewritten in tasks 9-10.

**Step 4: Commit**

```
refactor: replace emitArrayCopyLoop with array.copy instruction
```

---

## Task 9: Rewrite mutating array methods (push, pop, shift, reverse, splice)

**Files:**
- Modify: `src/codegen/expressions.ts` — functions:
  - `compileArrayPush` (lines 3514-3575)
  - `compileArrayPop` (lines 3580-3636)
  - `compileArrayShift` (lines 3641-3698)
  - `compileArrayReverse` (lines 3431-3508)
  - `compileArraySplice` (lines 3933-4028)

All method signatures change: they now receive `vecTypeIdx`, `arrTypeIdx`, `elemType` instead of just `typeIdx`, `elemType`.

### 9a: Rewrite `compileArrayPush`

**New algorithm:**
1. Get vec struct ref and store in local
2. `struct.get` length and data from vec
3. Compare length to `array.len(data)` (capacity check)
4. If full: allocate new backing array with `max(length*2, 4)`, `array.copy` old data, `struct.set` data field
5. `struct.get` data, set element at index=length using `array.set`
6. Increment length: `struct.get` length, `i32.add 1`, `struct.set` length
7. Return new length as f64

Key difference: NO new vec struct allocation. Mutate in place. The receiver local is NOT reassigned — the struct is mutated. This also means the module global proxy doesn't need writeback for push/pop/shift since the struct itself is mutated (but the global still holds the same struct ref).

Wait — actually the module global proxy still needs the initial `global.get` to load the struct ref into a local. But since the struct is mutated in-place, writeback (`global.set`) is NOT needed for mutating methods. The struct ref doesn't change, only its contents.

### 9b: Rewrite `compileArrayPop`

**New algorithm:**
1. Get vec ref, store in local
2. Read length, subtract 1
3. Read element at `data[length-1]` using `struct.get` data + `array.get`
4. Store element in temp
5. Decrement length: `struct.set` length field to length-1
6. Return popped element

No allocation, no copy. O(1).

### 9c: Rewrite `compileArrayShift`

**New algorithm:**
1. Get vec ref, store in local
2. Read first element `data[0]`, store in temp
3. `array.copy` data to itself: dst=data, dstOff=0, src=data, srcOff=1, count=length-1
4. Decrement length: `struct.set` length field
5. Return first element

No allocation. O(n) for the shift, same as JS.

### 9d: Rewrite `compileArrayReverse`

**New algorithm:**
1. Get vec ref
2. `struct.get` data field
3. `struct.get` length field
4. Same swap loop as before, but on the data array
5. Return the vec ref (same struct, mutated in-place)

Minor change: just add `struct.get $vec 1` to get data before the swap loop.

### 9e: Rewrite `compileArraySplice`

**New algorithm:**
1. Get vec ref, store in local
2. Read start and deleteCount args
3. Build deleted slice: create new vec struct with backing array of deleteCount, `array.copy` deleted elements
4. Shift tail left: `array.copy` data[start+deleteCount..len] → data[start..], count = len-start-deleteCount
5. Decrement length by deleteCount
6. Return deleted slice vec

No allocation for the main array. Only allocate for the returned deleted slice.

### Step: Run tests

Run: `npx vitest run tests/array-methods.test.ts`
Expected: push, pop, shift, reverse, splice tests pass.

### Step: Commit

```
feat: rewrite mutating array methods for capacity-based vec
```

---

## Task 10: Rewrite non-mutating array methods (indexOf, includes, slice, concat, join)

**Files:**
- Modify: `src/codegen/expressions.ts` — functions:
  - `compileArrayIndexOf` (lines 3282-3352)
  - `compileArrayIncludes` (lines 3357-3426)
  - `compileArraySlice` (lines 3703-3756)
  - `compileArrayConcat` (lines 3761-3809)
  - `compileArrayJoin` (lines 3815-3927)

### 10a: Update `compileArrayIndexOf` and `compileArrayIncludes`

These iterate over elements. Change:
- Use `struct.get $vec 0` for length (instead of `array.len`)
- Use `struct.get $vec 1` for data, then `array.get` for element access

### 10b: Rewrite `compileArraySlice`

**New algorithm:**
1. Get vec ref, extract length and data
2. Compute start/end/sliceLen (same logic)
3. Create new backing array: `array.new_default $arr sliceLen`
4. `array.copy` from source data[start..start+sliceLen] to new array
5. Wrap in new vec struct: push sliceLen, push new array, `struct.new $vec`
6. Return new vec

### 10c: Rewrite `compileArrayConcat`

**New algorithm:**
1. Get both vec refs, extract lengths and data arrays
2. Create new backing array: `array.new_default $arr (lenA + lenB)`
3. `array.copy` A's data[0..lenA] to new[0..]
4. `array.copy` B's data[0..lenB] to new[lenA..]
5. Wrap in new vec struct
6. Return new vec

### 10d: Update `compileArrayJoin`

Same pattern: extract data with `struct.get $vec 1`, use `struct.get $vec 0` for length, then same loop logic.

### Step: Run tests

Run: `npx vitest run tests/array-methods.test.ts`
Expected: ALL 22 array method tests pass.

### Step: Commit

```
feat: rewrite non-mutating array methods for vec struct
```

---

## Task 11: Update spread/rest array handling

**Files:**
- Modify: `src/codegen/expressions.ts:2124-2158` (spread in call args)
- Modify: `src/codegen/expressions.ts:2875-2994` (spread in array literals — already partially handled in task 5)

**Step 1: Update spread in function call arguments**

When spreading an array arg, the code currently uses `array.len` and `array.get`. Change to:
- `struct.get $vec 0` for length
- `struct.get $vec 1` for data, then `array.get` for elements

When packing trailing args into a rest param array, currently uses `array.new_fixed`. Change to create a vec struct wrapping the array.

**Step 2: Update rest parameter type registration**

In `src/codegen/index.ts` (around line 1829), where rest params call `getOrRegisterArrayType`, change to `getOrRegisterVecType`.

**Step 3: Run tests**

Run: `npx vitest run tests/spread-rest.test.ts`
Expected: All 13 spread-rest tests pass.

**Step 4: Commit**

```
feat: spread/rest use vec struct arrays
```

---

## Task 12: Update module-level array globals

**Files:**
- Modify: `src/codegen/index.ts:1910-1925` (module global registration)
- Modify: `src/codegen/expressions.ts:3168-3225` (module global proxy in compileArrayMethodCall)

**Step 1: Verify global type**

Module globals for arrays should already get the vec struct type via `resolveWasmType` (changed in task 3). Verify the init expression creates a proper vec struct (e.g. for `let arr: number[] = []` at module level).

**Step 2: Simplify module global proxy**

Since mutating methods (push, pop, shift, reverse, splice) now mutate the struct in-place instead of creating a new array, the writeback step (`global.set`) is only needed if the struct ref itself changes. For in-place mutations, no writeback is needed.

Review and simplify: the proxy still needs `global.get` to load the vec ref into a local for the method call, but skip `global.set` writeback for push, pop, shift, reverse (these mutate in-place). Keep writeback for splice only if it can reassign the receiver (it shouldn't with the new design).

**Step 3: Run tests**

Run: `npx vitest run tests/module-globals.test.ts`
Expected: Module-level array push+length test passes.

**Step 4: Commit**

```
feat: module-level array globals work with vec struct
```

---

## Task 13: Run full test suite and fix any remaining issues

**Files:**
- All modified files from previous tasks

**Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All 198+ tests pass.

**Step 2: Fix any failures**

Look for edge cases:
- Array passed as function parameter
- Array returned from function
- Array stored in class fields (if applicable)
- Nested arrays
- Empty array operations (pop on empty, shift on empty)
- Array used in for-of loops

**Step 3: Commit**

```
fix: resolve remaining test failures after vec struct migration
```

---

## Task 14: Remove dead code

**Files:**
- Modify: `src/codegen/expressions.ts` — remove `emitArrayCopyLoop` if fully replaced

**Step 1: Remove old `emitArrayCopyLoop`**

If all callers now use `array.copy` directly, delete the old function (lines 3229-3277).

**Step 2: Run tests**

Run: `npx vitest run`
Expected: All tests pass.

**Step 3: Commit**

```
refactor: remove dead emitArrayCopyLoop
```

---

## Task 15: Verify benchmark improvement

**Step 1: Build playground**

Run: `npx vite build` (or however the playground is built/served)

**Step 2: Run benchmark**

Open the playground, load the benchmark demo, run `runBenchmark()`.

Expected: `bench_array` should be within 2-5x of JS (down from 1058x).

**Step 3: If benchmark is not available locally, add a test**

Create `tests/array-perf.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

describe("array performance", () => {
  it("push 10k elements compiles and runs correctly", async () => {
    const src = `
      export function test(): number {
        const arr: number[] = [];
        for (let i = 0; i < 10000; i = i + 1) {
          arr.push(i);
        }
        let total = 0;
        for (let i = 0; i < arr.length; i = i + 1) {
          total = total + arr[i];
        }
        return total;
      }
    `;
    const result = compile(src);
    if (!result.success) throw new Error(result.errors.map(e => e.message).join("\n"));
    const { instance } = await WebAssembly.instantiate(result.binary, {
      env: { console_log_number: () => {}, console_log_bool: () => {}, console_log_string: () => {} },
    });
    expect((instance.exports as any).test()).toBe(49995000);
  });
});
```

**Step 4: Commit**

```
test: add array performance correctness test
```

---

## Summary of tasks

| Task | Description | Tests |
|------|-------------|-------|
| 1 | Add `array.copy` / `array.fill` to IR + emitters | All pass (no behavior change) |
| 2 | Add `vecTypeMap` + `getOrRegisterVecType` | All pass (not wired up) |
| 3 | Switch `resolveWasmType` to return vec type | Breaks array tests (expected) |
| 4 | Update `resolveArrayInfo` + helpers | Still broken |
| 5 | Array literals create vec structs | Still broken (no access yet) |
| 6 | Element access, assignment, .length | arrays-enums tests pass |
| 7 | Array destructuring | destructuring tests pass |
| 8 | Replace copy loops with `array.copy` | Copy callers updated |
| 9 | Rewrite mutating methods (push/pop/shift/reverse/splice) | array-methods mutating pass |
| 10 | Rewrite non-mutating methods (indexOf/includes/slice/concat/join) | array-methods ALL pass |
| 11 | Spread/rest array handling | spread-rest tests pass |
| 12 | Module-level array globals | module-globals test passes |
| 13 | Full suite fix-up | ALL 198+ tests pass |
| 14 | Remove dead code | Clean |
| 15 | Verify benchmark improvement | bench_array ~2-5x of JS |
