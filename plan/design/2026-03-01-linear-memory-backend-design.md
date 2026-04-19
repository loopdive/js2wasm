# Linear-Memory Backend Design

## Goal

Add a second compilation target to js2wasm that emits standard Wasm with linear
memory instead of WasmGC. The primary use-case is compiling `src/link/` into a
portable `linker.wasm` that runs in any Wasm runtime (Wasmtime, Wasmer, Wamr,
browsers).

## Architecture

A new compiler option `{ target: "linear" }` (default remains `"gc"`) selects
the backend at compile time. Both targets share the same frontend (parsing, type
checking, IR lowering). They diverge at codegen:

```
TS source → frontend → IR
                         ├─ target:"gc"     → codegen/     → WasmGC module
                         └─ target:"linear"  → codegen-linear/ → linear-memory module
```

The two backends never coexist in one output module. No binary-size cost when
using the default GC target.

## Memory Layout

All heap objects live in linear memory using a bump allocator. Each object starts
with an 8-byte header:

```
offset  size  field
0       1     type tag (0=free, 1=Array, 2=String, 3=Map, 4=Set, 5=Struct, 6=Uint8Array)
1       3     padding (alignment)
4       4     payload size in bytes
```

### Type layouts (after header)

**Array** (tag 1): `[len:u32][cap:u32][elements: f64×cap]`

**String** (tag 2): `[len:u32][utf8 bytes]`

**Map** (tag 3): open-addressing hash table
`[count:u32][cap:u32][entries: (hash:u32, keyPtr:u32, valPtr:u32)×cap]`

**Set** (tag 4): similar to Map without values
`[count:u32][cap:u32][entries: (hash:u32, keyPtr:u32)×cap]`

**Struct** (tag 5): `[field0][field1]...` — fields laid out per class
definition, each f64-sized (8 bytes) for uniform access.

**Uint8Array** (tag 6): `[len:u32][bytes]`

### Allocator

A simple bump allocator using a global `__heap_ptr`:

```wasm
(global $__heap_ptr (mut i32) (i32.const <heap_start>))
```

`__malloc(size: i32) → i32` bumps the pointer, aligns to 8 bytes. No GC or
free — sufficient for the linker's batch-process-then-exit pattern. If needed
later, a free list or arena can replace it.

## Codegen Strategy

### Variables and parameters

All local values are `i32` (pointers to heap objects) or `f64` (numbers). The
codegen infers which representation based on the TS type.

### Object construction

`new Map()` → call `__map_new()` which calls `__malloc` and initializes header +
empty table.

### Property access

`obj.field` on a struct → `i32.load offset=<header + field_offset>`.

### Method calls

`map.get(key)` → call `__map_get(mapPtr, keyPtr)`. Runtime functions are emitted
as wasm functions in the output module (not imports).

### String operations

String equality, concatenation, and hashing are implemented as runtime
functions: `__str_eq`, `__str_concat`, `__str_hash`.

### Control flow

Identical to the GC backend — `if/else`, `block/loop/br`, `call`, `return` map
the same way.

### Numbers

All numbers are `f64` by default (same as GC backend). Integer operations that
the linker uses (bitwise, byte manipulation) work on `f64` with appropriate
`i32.trunc_f64_s` / `f64.convert_i32_s` conversions.

## Runtime Functions

Emitted directly into the output module's code section:

| Function | Signature | Purpose |
|----------|-----------|---------|
| `__malloc` | `(size: i32) → i32` | Bump allocator |
| `__map_new` | `() → i32` | Create empty Map |
| `__map_get` | `(map: i32, key: i32) → i32` | Map lookup |
| `__map_set` | `(map: i32, key: i32, val: i32)` | Map insert |
| `__map_has` | `(map: i32, key: i32) → i32` | Map membership |
| `__map_keys` | `(map: i32) → i32` | Map keys as Array |
| `__set_new` | `() → i32` | Create empty Set |
| `__set_add` | `(set: i32, key: i32)` | Set insert |
| `__set_has` | `(set: i32, key: i32) → i32` | Set membership |
| `__arr_new` | `(cap: i32) → i32` | Create Array with capacity |
| `__arr_push` | `(arr: i32, val: i32)` | Array push |
| `__arr_get` | `(arr: i32, idx: i32) → i32` | Array index |
| `__arr_set` | `(arr: i32, idx: i32, val: i32)` | Array set |
| `__arr_len` | `(arr: i32) → i32` | Array length |
| `__str_eq` | `(a: i32, b: i32) → i32` | String equality |
| `__str_concat` | `(a: i32, b: i32) → i32` | String concatenation |
| `__str_hash` | `(s: i32) → i32` | String hash (for Map/Set) |
| `__u8arr_new` | `(len: i32) → i32` | Create Uint8Array |
| `__u8arr_get` | `(arr: i32, idx: i32) → i32` | Byte read |
| `__u8arr_set` | `(arr: i32, idx: i32, val: i32)` | Byte write |
| `__u8arr_slice` | `(arr: i32, s: i32, e: i32) → i32` | Slice |

## Testing and Acceptance

1. **Unit tests**: Runtime functions tested in isolation (malloc returns aligned
   pointers, Map get/set round-trips, string equality works).

2. **Integration test**: Compile a small TS program with `{ target: "linear" }`,
   run in Node's WebAssembly, verify output.

3. **Linker self-host test**: Compile `src/link/` with `{ target: "linear" }`,
   run the resulting `linker.wasm` on a test fixture (two .o files → merged
   module), compare output byte-for-byte with the TypeScript linker.

4. **Wasmtime validation**: Run `linker.wasm` through `wasmtime run` to confirm
   portability.

## Scope Constraints

- Only the TS features used by `src/link/` need to work in the linear backend.
  This is: classes, Map, Set, Array, Uint8Array, string operations, for-of,
  if/else, functions, closures (limited), bitwise ops.
- No closures over mutable state needed (linker doesn't use them).
- No async/await, no DOM, no exceptions in the linear backend.
- No GC — bump allocation is sufficient for the linker's use pattern.
