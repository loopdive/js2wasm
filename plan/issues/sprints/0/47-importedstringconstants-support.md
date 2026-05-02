---
id: 47
title: "Issue 47: importedStringConstants support"
status: done
created: 2026-03-02
updated: 2026-04-14
completed: 2026-03-03
goal: developer-experience
---
# Issue 47: importedStringConstants support

## Summary

Use the `importedStringConstants` compile option (part of the wasm:js-string builtins spec)
to import string literals as globals from a dedicated namespace instead of importing them
as thunk functions from `env`.

## Current behavior

String literals are imported as functions from `env`:
```wat
(import "env" "__str_0" (func (result externref)))
```
Each access calls the import function to get the string value.

## Desired behavior

String literals are imported as globals from a string constants namespace:
```wat
(import "string_constants" "abcde" (global (ref extern)))
```
At instantiation, pass `{ importedStringConstants: 'string_constants' }` in `compileOptions`.
The engine resolves string constants at compile time — no function call overhead per access.

## Implementation

### Codegen (`src/codegen/index.ts`)
- Change `collectStringLiterals` / `collectStringLiteralsForLibMultiFile` to emit
  global imports from the string constants namespace instead of `env` function imports
- Global type: `(ref extern)` (non-nullable)
- Import name: the literal string value itself

### Runtime (`src/runtime.ts`)
- Add `importedStringConstants` to the `compileOptions` in `instantiateWasm()`
- Fallback: provide string constants as globals in the import object

### Binary emitter (`src/emit/binary.ts`)
- Global imports with `ref_extern` type already supported after #47 prep work

### Playground (`playground/main.ts`)
- Uses `instantiateWasm()` — no changes needed

## Complexity

M — ~200 lines across 3 files
