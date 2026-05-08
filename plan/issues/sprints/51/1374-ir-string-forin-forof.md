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

## Resolution (Path B — fix the real string-for-of caller bug)

After exploration, the spec was partially outdated:

**Already on main**: string for-of IS IR-claimed in both modes
(`src/ir/from-ast.ts:2627` dispatches to `lowerForOfString` in
nativeStrings or `lowerForOfIterFromExternrefValue` in host-strings).
A bare `function countChars(s: string): number { let n = 0; for (const c of s) n++; return n; }`
emits `forof.iter` IR.

**The real gap I found**: a CALLER of a string-iterating function
failed IR-lowering with `ir/lower: duplicate SSA def for N in <caller>`.
Even `function f(s: string): number { let n = 0; for (const c of s) n++; return n; }`
followed by `export function test(): number { return f("hi"); }`
fell back. The for-of function itself was IR; its caller fell back.

### Root cause

`inline-small.ts:canInline` allowed callees containing body-bearing
instrs (forof.*, try, while.loop, for.loop) to be inlined. The
splice path renamed top-level callee body instr results to fresh
caller-scope ids — but did NOT walk into nested body buffers
(forof.iter.body, etc.). Nested instr results stayed as callee-scope
ids; `lower.ts:registerInstrDefs` (which DOES recurse into body
buffers) then flagged the collision against caller's own ids.

A naive deep-rename fix surfaced a second bug: `renameInstrOperands`
already recurses into body buffers (renaming operands). If the deep
helper also recurses with `renameAllInInstr` (which calls
`renameInstrOperands` again), the rename map gets applied twice — and
because fresh caller-scope ids are allocated from
`caller.valueCount + n`, they coincide with callee-scope ids, so the
second pass DOUBLE-MAPS already-renamed operands. Symptom: inlined
`binary { lhs: 4, rhs: 5, result: 5 }` (rhs and result alias) →
`lower.ts:emitValue` infinite-recurses on the self-loop ("Maximum
call stack size exceeded").

### Fix

Conservative: extend `canInline` to reject callees whose top-level
body instrs include any body-bearing kind (`forof.vec`, `forof.iter`,
`forof.string`, `try`, `while.loop`, `for.loop`). The caller still
goes through IR — it just emits a regular `call` instr to the
standalone callee instead of inlining its body.

This avoids both the SSA-rename complexity AND the slot-migration
problem (callee's slot indices wouldn't survive a splice into the
caller's slot table). Lifting the restriction would require
migrating callee slots into the caller and a one-pass deep SSA
rename — out of scope for this slice.

### What this DOES NOT do

- AC#1 (`countChars` IR-claimed via array.get / __string_charAt) was
  already true on main; this slice doesn't change it.
- AC#2 (for-in unrolled statically over class instances) is still
  missing — `src/ir/select.ts` has no `isForInStatement` and
  `src/ir/from-ast.ts` has no `lowerForInStatement`. Tracked as a
  follow-up. The new `for-in-externref` reason is also not added in
  this slice (no for-in support at all).
- AC#3 (for-in over externref falls through with telemetry) — same.

### Test results

`tests/issue-1374-ir-string-iter-inline.test.ts` — 7 cases:

- ✓ Caller of a string-for-of helper compiles via IR (no duplicate SSA def)
- ✓ Caller of a string-for-of helper produces correct runtime result
- ✓ String-for-of helper with no comparison in caller compiles via IR
- ✓ Two-level call chain (`g()` calls `f()` calls for-of) compiles via IR
- ✓ Vec-for-of caller still works (regression check)
- ✓ Standalone string-for-of (no caller) still works (regression check)
- ✓ Identifier-only function call (no body-buffer in callee) still inlines fine

`npm test -- tests/ir/` — 39/39 IR tests pass (no regression in inline-small,
constant-fold, dead-code, simplify-cfg, phase3c).

`pnpm run check:ir-fallbacks` — green, no baseline change.
