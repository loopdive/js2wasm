---
id: 32
title: "Issue 32: Capacity-based array representation with `array.copy`"
status: done
created: 2026-03-01
updated: 2026-04-14
completed: 2026-03-01
goal: spec-completeness
---
# Issue 32: Capacity-based array representation with `array.copy`

## Status: done

## Summary
Replace bare WASM GC arrays with a struct wrapper `{length, data}` that supports capacity-based growth and use `array.copy` for all bulk copy operations. This turns `push` from O(n) to amortized O(1) and eliminates unnecessary allocations in `pop`, `shift`, and `splice`.

## Motivation
The `bench_array` benchmark (10k pushes + sum) runs 1058x slower in WASM than JS. Root cause: every `push` allocates a brand-new array and copies all elements one by one. For 10k pushes this means ~50M element copies (O(n²)).

JS arrays use amortized O(1) push with internal capacity doubling. Kotlin/Wasm, Dart, and Java/J2Wasm all use the same struct-wrapper pattern described below.

Secondary issue: the compiler uses element-by-element copy loops (`emitArrayCopyLoop`) instead of the `array.copy` instruction available in the WASM GC spec.

## Design

### New type representation

For each element kind (f64, i32, externref, ref_N), register two types:

```wat
;; Raw backing storage (already exists)
(type $__arr_f64 (array (mut f64)))

;; NEW: Growable vector wrapper
(type $__vec_f64 (struct
  (field $length (mut i32))              ;; logical length
  (field $data   (mut (ref $__arr_f64))) ;; backing array; capacity = array.len($data)
))
```

TS `number[]` resolves to `(ref_null $__vec_f64)` instead of `(ref_null $__arr_f64)`.

Capacity is implicit (`array.len` on the data field) — no extra field needed.

### New IR instructions

Add to `Instr` union in `ir/types.ts`:
```ts
| { op: "array.copy"; dstTypeIdx: number; srcTypeIdx: number }
| { op: "array.fill"; typeIdx: number }
```

Add to `GC` in `emit/opcodes.ts`:
```ts
array_copy: 0x11,
array_fill: 0x10,
```

### Growth strategy

- Initial capacity for `[]`: 0 (data = `array.new_default 0`)
- On `push` when `length == capacity`: new capacity = `max(length * 2, 4)`
- Allocate new backing array, `array.copy` old data, update struct `$data` field

### Operation changes

| Operation | Before | After |
|-----------|--------|-------|
| `[]` literal | `array.new_fixed 0` | `i32.const 0` + `array.new_default 0` + `struct.new` |
| `[1,2,3]` literal | `array.new_fixed 3` | `array.new_fixed 3` + `i32.const 3` (swap order for struct.new) + `struct.new` |
| `arr[i]` read | `array.get` | `struct.get $data` → `array.get` |
| `arr[i] = v` write | `array.set` | `struct.get $data` → `array.set` |
| `arr.length` | `array.len` | `struct.get $length` |
| `push(v)` | alloc new array + copy all + set last | if full: grow; `array.set` at length; increment length |
| `pop()` | alloc new array(len-1) + copy | decrement length; read last element |
| `shift()` | alloc new array(len-1) + copy from [1..] | `array.copy` shift left by 1; decrement length |
| `reverse()` | in-place swap | `struct.get $data` → same in-place swap |
| `splice(s,d)` | alloc new + copy head/tail | `array.copy` shift tail left; decrement length; return deleted slice |
| `slice(s,e)` | alloc new + copy | alloc new vec; `array.copy` |
| `concat(b)` | alloc new + copy a + copy b | alloc new vec; `array.copy` a; `array.copy` b |
| `indexOf/includes` | loop | `struct.get $data` → same loop |
| `join` | loop | `struct.get $data` → same loop |
| all bulk copies | `emitArrayCopyLoop` (element-by-element) | `array.copy` instruction |
| destructuring | `array.get` at constant indices | `struct.get $data` → same `array.get` |
| module globals | proxy local + writeback | same mechanism, `$__vec_*` type |

### Helper: `getOrRegisterVecType`

New function alongside `getOrRegisterArrayType`:

```ts
function getOrRegisterVecType(ctx: CodegenContext, elemKind: string, elemType?: ValType): number {
  if (ctx.vecTypeMap.has(elemKind)) return ctx.vecTypeMap.get(elemKind)!;
  const arrTypeIdx = getOrRegisterArrayType(ctx, elemKind, elemType);
  const structIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: `__vec_${elemKind}`,
    fields: [
      { name: "length", type: { kind: "i32" }, mutable: true },
      { name: "data", type: { kind: "ref", typeIdx: arrTypeIdx }, mutable: true },
    ],
  });
  ctx.vecTypeMap.set(elemKind, structIdx);
  return structIdx;
}
```

### Helper: `emitGrowIfNeeded`

Emits the capacity-check + grow sequence for `push`:

```
;; stack: [struct_ref]
;; check length == array.len(data)
local.get $vec
struct.get $__vec $length
local.get $vec
struct.get $__vec $data
array.len
i32.eq
if
  ;; newCap = max(length * 2, 4)
  ;; newData = array.new_default(newCap)
  ;; array.copy newData 0 oldData 0 length
  ;; struct.set $__vec $data newData
end
```

### `resolveWasmType` change

In `resolveWasmType`, when `sym.name === "Array"`:
- Still compute `elemKind` and `elemWasm` as before
- Call `getOrRegisterVecType` instead of `getOrRegisterArrayType`
- Return `{ kind: "ref_null", typeIdx: vecStructIdx }`

Need a way to retrieve the backing array type index from the vec struct type index. Options:
- Store mapping `vecTypeMap` → `arrTypeMap` in context
- Or derive from the struct's field[1].type

### Codegen context additions

```ts
interface CodegenContext {
  // existing:
  arrayTypeMap: Map<string, number>;
  // new:
  vecTypeMap: Map<string, number>;
}
```

### WAT emitter changes

Add `array.copy` and `array.fill` to the WAT text emitter in `emit/wat.ts`.

### Binary emitter changes

Add `array.copy` and `array.fill` to `emit/binary.ts`:
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

## Scope

### Files to modify

| File | Changes |
|------|---------|
| `src/ir/types.ts` | Add `array.copy` and `array.fill` to `Instr` union |
| `src/emit/opcodes.ts` | Add `array_copy: 0x11`, `array_fill: 0x10` to `GC` |
| `src/emit/binary.ts` | Emit `array.copy` and `array.fill` instructions |
| `src/emit/wat.ts` | Text format for `array.copy` and `array.fill` |
| `src/codegen/index.ts` | Add `vecTypeMap` to context, `getOrRegisterVecType`, update `resolveWasmType`, update module global init for vec types |
| `src/codegen/expressions.ts` | Rewrite all array methods (push, pop, shift, reverse, splice, slice, concat, indexOf, includes, join), element access, element assignment, array literals, destructuring support, `emitArrayCopyLoop` → `array.copy`, add `emitGrowIfNeeded` |
| `src/codegen/statements.ts` | Update array destructuring to `struct.get $data` first |

### Files to add

| File | Purpose |
|------|---------|
| `tests/array-vec.test.ts` | Tests for capacity-based array behavior |

## Complexity: L

## Acceptance criteria
- `bench_array` (10k push + sum) runs within 2-5x of JS, not 1000x
- All existing array tests pass (22 in `array-methods.test.ts`, 5 in `arrays-enums.test.ts`)
- `[].push(x)` does not allocate a new array on every call
- `pop()` does not allocate
- `arr[i]` and `arr.length` still work correctly
- Module-level array globals still work with proxy writeback
- Array destructuring still works
- Spread/rest with arrays still works
- WAT output shows `array.copy` instead of element-by-element loops
