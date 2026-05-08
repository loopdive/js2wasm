---
id: 1374
sprint: 51
title: "IR: string for-of and for-in through IR (removes legacy fallback for string iteration)"
status: in-progress
created: 2026-05-08
priority: medium
feasibility: medium
reasoning_effort: high
task_type: feature
area: ir, codegen
language_feature: iteration, strings
goal: ir-full-coverage
---
# #1374 — IR: string for-of and for-in

## Problem

The IR for-of implementation in `src/ir/from-ast.ts` handles the **vec fast-path** only:

```typescript
// for-of: only vec (array) is accepted; string/externref routes to legacy via a clean throw.
// src/ir/from-ast.ts:912
```

When the iterable is a `string` or `externref`, the from-ast layer throws, causing the entire
containing function to fall back to legacy. This blocks IR coverage of any function that
iterates over a string or a union-typed iterable.

Similarly, `for-in` over an object's keys is entirely on the legacy path — the for-in IR
slice has not been written.

## Root cause

`src/ir/select.ts` `isForOfStatement` (around line 645) requires the iterable to be
vec-typed. The from-ast lowerer (line 908) confirms this and throws for non-vec.

## Implementation plan

### String for-of (nativeStrings path)

In `src/ir/select.ts`, extend the `isForOfStatement` gate to also accept `string`-typed
iterables when `nativeStrings` is enabled (i.e., the iterable's TS type resolves to `string`).

In `src/ir/from-ast.ts`:
- When iterable type is `string`, emit:
  ```
  $len = string_len($iterable)
  $i = 0
  loop {
    if $i >= $len { break }
    $char = string_charAt($iterable, $i)   // IrNode.stringCharAt
    <body>
    $i = $i + 1
    continue
  }
  ```
- `IrNode.stringCharAt { str: IrNode; index: IrNode }` → lowered to `array.get $char_array $i`
  (for nativeStrings) or `__string_charAt` host import (for JS-string mode).

Wire `IrLowerResolver.stringCharAt` in `integration.ts`.

### For-in (object key iteration)

`for (const k in obj)` is `for-in`. When `obj` is a class instance:
- The key set is statically known (class fields from `ctx.structFields`).
- Emit a series of `$body($field_name_literal)` unrolled calls at compile time.
- This is only valid when the body doesn't reassign fields. Add a guard in the selector.

When `obj` is `externref` (dynamic object): fall through to legacy — emit a
`"for-in-externref"` `IrFallbackReason` for telemetry.

## Acceptance criteria

1. `function countChars(s: string): number { let n = 0; for (const c of s) n++; return n; }`
   is IR-claimed and emits via `array.get` (nativeStrings) or `string_charAt` host import.
2. `for (const k in instance)` over a local class instance is unrolled statically (3 fields
   → 3 body invocations).
3. `for (const k in externalObj)` correctly falls through with `"for-in-externref"`.
4. Existing string-iteration equivalence tests pass.

## Files

- `src/ir/select.ts` — extend `isForOfStatement` + add `isForInStatement`
- `src/ir/from-ast.ts` — string for-of lowering + for-in class unrolling
- `src/ir/nodes.ts` — `IrNode.stringCharAt` + `IrNode.stringLen`
- `src/ir/lower.ts` — lower string nodes to WasmGC ops
- `src/ir/integration.ts` — resolver methods for string ops
