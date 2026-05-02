---
id: 3
title: "Issue 3: Arrays"
status: done
created: 2026-02-27
updated: 2026-04-14
completed: 2026-02-27
goal: builtin-methods
---
# Issue 3: Arrays

## Status: done

## Summary
Support typed arrays: array literal, element read/write, `length`, and `push`.

## Motivation
Arrays are essential for any non-trivial computation. The IR already has `array.new`, `array.get`, `array.set`, `array.len` opcodes from the Wasm GC proposal.

## Design

### Type mapping
`number[]` / `Array<number>` → Wasm GC array type `(array (mut f64))`
`string[]` / `Array<string>` → `(array (mut externref))`
`any[]` / `any` → `(array (mut externref))`

Array types are registered in `mod.types` as `ArrayTypeDef`. A map `ctx.arrayTypeMap: Map<string, number>` (keyed by element type kind) tracks registered array types.

### Operations
| TS | Wasm |
|---|---|
| `[1, 2, 3]` | `array.new_fixed $arr_f64 3` with elements pushed |
| `arr[i]` | `array.get $arr_f64` (index as i32) |
| `arr[i] = v` | `array.set $arr_f64` |
| `arr.length` | `array.len` |
| `arr.push(v)` | not supported (Wasm GC arrays are fixed-length); emit error |

### Index type
Array indices in TS are `number` (f64). Before `array.get/set`, truncate with `i32.trunc_f64_s`.

## Scope
- `src/ir/types.ts`: no changes needed (ArrayTypeDef already exists).
- `src/codegen/index.ts`: add `ctx.arrayTypeMap`, add `getOrRegisterArrayType()` helper, add array type to `resolveWasmType` for array TS types.
- `src/codegen/expressions.ts`: implement `compileArrayLiteral`, `compileElementAccess`, element assignment in `compileExternPropertySet`.
- `src/emit/binary.ts` + `src/emit/wat.ts`: verify array opcodes are already emitted (they should be from IR).
- Tests: add in `tests/codegen.test.ts` or a new `tests/arrays.test.ts`.

## Acceptance criteria
- `const a = [1, 2, 3]; return a[1];` returns `2`.
- `a[0] = 99; return a[0];` returns `99`.
- `return [1, 2, 3].length;` returns `3`.
- Array of externref (strings) works.
