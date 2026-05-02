---
id: 461
title: "Array of structs: array.new_default fails for non-defaultable ref types"
status: done
created: 2026-03-17
updated: 2026-04-14
completed: 2026-04-14
priority: high
goal: compilable
files:
  src/codegen/expressions.ts:
    breaking:
      - "compileArrayLiteral — use ref_null element type for struct arrays"
  src/codegen/index.ts:
    breaking:
      - "getOrRegisterArrayType — allow nullable element types for struct arrays"
---
# #461 — Array of structs: array.new_default fails for non-defaultable ref types

## Status: ready

## Problem

Arrays of struct types (e.g., `Task[]` where Task is a class/interface) fail Wasm validation because `array.new_default` requires a defaultable element type. Non-nullable struct refs (`ref $Task`) are not defaultable — they have no null value.

## Details

```typescript
interface Task { id: number; callback: () => void; }
const tasks: Task[] = [];
tasks.push(newTask);
```

The compiler creates `(array (ref $Task))` but `array.new_default` needs `(array (ref null $Task))` since `ref $Task` has no default value.

## Fix

Use `ref_null` (nullable) element types for arrays of struct types:
- `(array (mut (ref null $Task)))` instead of `(array (mut (ref $Task)))`
- When reading elements, use `ref.as_non_null` if a non-null ref is needed

This is the standard WasmGC pattern for arrays of objects.

## Impact

Blocks React scheduler compilation (#455). Also affects any code using arrays of class instances or interface objects.

## Complexity: M
