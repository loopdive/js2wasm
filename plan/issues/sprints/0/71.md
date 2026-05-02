---
id: 71
title: "Issue 71: Fast mode — WasmGC-native strings"
status: done
created: 2026-03-09
updated: 2026-04-14
completed: 2026-03-07
goal: standalone-mode
---
# Issue 71: Fast mode — WasmGC-native strings

## Summary

Implement a wasm-native string type for fast mode that eliminates host boundary
crossings. Strings are stored as WasmGC structs with an `i16` array for WTF-16
code units. All string operations compile to pure wasm functions.

This is Phase 2 of issue #70.

## Motivation

In the default compiler, every string operation (`s.length`, `s.trim()`,
`s + t`) crosses the wasm/host boundary via externref. For string-heavy code
this is the dominant performance bottleneck. Native strings keep all data and
operations inside wasm, with the engine's GC handling memory.

## Design

Two-tier implementation:

- **Tier 1 (GC target):** WasmGC struct + GC i16 array, engine handles memory
- **Tier 2 (linear target):** ptr+len in linear memory, bump allocator (deferred to Phase 4 / C ABI)

### Tier 1: String layout (WasmGC)

```wat
(type $NativeString (struct
  (field $len i32)                        ;; length in code units
  (field $data (ref (array (mut i16))))   ;; WTF-16 code units
))
```

WTF-16 encoding (not strict UTF-16) to match JavaScript semantics exactly,
including unpaired surrogates. Configurable to UTF-8 in a future follow-up
via `stringEncoding: "utf8"` compiler option.

### Compilation strategy — hybrid inline/shared

- **Inline** (single instruction): `length`, `charCodeAt` — emit `struct.get`
  / `array.get` directly at call site
- **Shared helper functions** (emitted once per module): `concat`, `charAt`,
  `substring`, `slice`, `indexOf`, `equals` — call sites emit
  `call $__str_concat` etc.

### Boundary marshaling

Explicit helper functions auto-inserted by the compiler at import/export
boundaries:

- `$__str_to_extern(ref $NativeString) -> externref` — copies WTF-16 data to
  a JS string via a host import (`__str_decode(ref (array i16), i32) -> externref`)
- `$__str_from_extern(externref) -> ref $NativeString` — copies JS string data
  into a new GC array via a host import (`__str_encode(externref, ref (array i16))`)

The compiler detects when a native string flows to/from a host function
(exports, imports, `console.log`, DOM calls) and wraps the value with the
appropriate marshal call.

### String literals

String literals are embedded as data in the module. At initialization, each
literal is materialized into a `$NativeString` struct. The existing
`importedStringConstants` mechanism is replaced in fast mode — instead of
importing externref globals, literals become wasm-internal GC objects.

### Tier 2: String layout (linear memory)

```
+--------+----------------------------+
| len:u32| data: WTF-16 code units... |
+--------+----------------------------+
  i32 ptr to start of this block
```

Passed as `(ptr: i32, len: i32)` pairs across C ABI boundaries. Uses the
bump allocator from the linear memory backend. Deferred to Phase 4.

### Compiler option

```typescript
compile(source, {
  fast: true,                // GC-backed native strings (tier 1)
  // stringEncoding: "wtf16",  // default, matches JS
  // stringEncoding: "utf8",   // future: compact, C-compatible
});

compile(source, {
  fast: true,
  target: "linear",         // linear memory native strings (tier 2)
  abi: "c",
});
```

## Initial scope (this issue)

### Operations implemented in pure wasm

| Operation | Strategy | Notes |
|-----------|----------|-------|
| `length` | inline `struct.get $len` | O(1) |
| `charCodeAt(i)` | inline `array.get` | O(1), bounds-checked |
| `charAt(i)` | shared helper | returns single-char NativeString |
| `+` (concat) | shared helper | allocate new array, `array.copy` both sides |
| `===` / `!==` | shared helper | length check + element-wise compare loop |
| `substring(s, e)` | shared helper | allocate + `array.copy` slice |
| `slice(s, e)` | shared helper | negative index handling + substring |

### Boundary marshaling

| Helper | Direction | Implementation |
|--------|-----------|----------------|
| `$__str_to_extern` | wasm -> host | host import decodes i16 array to JS string |
| `$__str_from_extern` | host -> wasm | host import encodes JS string into i16 array |

### Deferred to follow-up

- `indexOf`, `lastIndexOf`, `includes`, `startsWith`, `endsWith`
- `trim`, `trimStart`, `trimEnd`
- `repeat`, `padStart`, `padEnd`, `split`
- `toUpperCase`, `toLowerCase`, `replace` (may stay host-delegated via marshal)
- `stringEncoding: "utf8"` option
- Linear memory string tier (covered by Phase 4 / C ABI)

## Complexity

L — New type system plumbing, ~8 shared helper functions, marshal layer,
string literal initialization, changes to expressions.ts and index.ts codegen.
