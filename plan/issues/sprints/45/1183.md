---
id: 1183
title: "IR Phase 4 Slice 6 part 4 — string fast path through the IR (`for (c of \\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\"hello\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\")`)"
status: done
created: 2026-04-27
updated: 2026-04-28
completed: 2026-04-28
priority: medium
feasibility: medium
reasoning_effort: high
task_type: feature
area: codegen
language_feature: compiler-internals
goal: iterator-protocol
depends_on: [1181]
origin: surfaced from #1169e foundation PR (#63) — slice 6 step D from the spec, deferred from #1181 (vec fast path) and #1182 (iterator protocol)
related: [1169e, 1181, 1182]
---
# #1183 — Slice 6 part 4: string fast path through IR

## Goal

Land slice 6 step D (per the #1169e spec): for-of over a
`string`-typed expression. In native-strings mode, iterate via
`__str_charAt` per code unit; in host-strings mode, fall through to
the iterator protocol path (#1182).

Depends on #1181 (vec fast path) for the loop-body machinery, and
optionally on #1182 if the host-strings fallback is to use the
iterator protocol.

## What this issue needs to land

### 1. `lowerForOfString` in `src/ir/from-ast.ts`

A third arm of the `lowerForOfStatement` strategy switch. Mirrors
the legacy `compileForOfString` (`src/codegen/statements/loops.ts:1483`):

```ts
function lowerForOfString(
  strV: IrValueId,
  loopVarName: string,
  stmt: ts.ForOfStatement,
  cx: LowerCtx,
): void {
  // Mode dispatch: native-strings → counter loop with __str_charAt.
  // Host-strings → fall through to iter-host path (#1182). The decision
  // happens at lowering time via cx.resolver?.nativeStrings?.() — a
  // new optional method on IrLowerResolver returning whether we're in
  // native-strings mode.
  if (!cx.resolver?.nativeStrings?.()) {
    return lowerForOfIter(coerceStringToExternref(strV, cx), loopVarName, stmt, cx);
  }

  // Allocate slots: counter (i32), length (i32), str (string ref),
  // element (string — single-char string).
  const counterSlot = cx.builder.declareSlot("__forof_si", { kind: "i32" });
  const lengthSlot  = cx.builder.declareSlot("__forof_slen", { kind: "i32" });
  const strSlot     = cx.builder.declareSlot("__forof_str", cx.resolver.resolveString!());
  const elemSlot    = cx.builder.declareSlot("__forof_selem", cx.resolver.resolveString!());

  // Bind loopVarName as a slot binding. Body collected via
  // collectBodyInstrs into a forof.string declarative instr.
  // Lowerer emits the wasm pattern below.
}
```

### 2. New `forof.string` declarative IR instr (in `src/ir/nodes.ts`)

Parallel to `forof.vec` from #1169e. Carries:
- `str: IrValueId` (the string SSA value, IrType.string)
- pre-allocated slots: counter, length, str, element
- `body: readonly IrInstr[]`

Result: void.

### 3. Lowering — Wasm pattern for native-strings mode

```wasm
;; str on stack
local.set $str_slot
local.get $str_slot
struct.get $AnyString $len            ;; length
local.set $len_slot
i32.const 0
local.set $counter_slot
block
  loop
    local.get $counter_slot
    local.get $len_slot
    i32.ge_s
    br_if 1
    ;; element = __str_charAt(str, counter)
    local.get $str_slot
    local.get $counter_slot
    call $__str_charAt
    local.set $elem_slot
    <body>
    local.get $counter_slot
    i32.const 1
    i32.add
    local.set $counter_slot
    br 0
  end
end
```

Need to confirm `__str_charAt` is registered by the
`registerNativeStringTypes` family in `src/codegen/native-strings.ts`
and that its signature is `(string-ref, i32) → string-ref`.

### 4. Strategy dispatch update

Extend `chooseForOfStrategy` from #1182:

```ts
function chooseForOfStrategy(iterableType: IrType, cx: LowerCtx): "vec" | "string-native" | "iter-host" {
  if (iterableType.kind === "val") {
    const vt = iterableType.val;
    if (vt.kind === "ref" || vt.kind === "ref_null") {
      const vec = cx.resolver?.resolveVec?.(vt);
      if (vec) return "vec";
    }
  }
  if (iterableType.kind === "string") {
    return cx.resolver?.nativeStrings?.() ? "string-native" : "iter-host";
  }
  return "iter-host";
}
```

### 5. `cx.resolver.nativeStrings()` accessor

A new optional method on `IrLowerResolver`. Implementation in
`integration.ts` returns `ctx.nativeStrings`.

## Out of scope

- Per-grapheme iteration (the JS spec iterates over code points, not
  code units; legacy uses `__str_charAt` which iterates code units —
  match legacy for now and surface a follow-up if test262 exposes
  the discrepancy).
- For-await over async string-emitting iterables — slice 7.

## Acceptance criteria

1. `for (const c of "hello") { ... }` IR-claims in native-strings
   mode and produces the same Wasm length and behavior as legacy
   (verified via a one-shot `wasm-objdump` diff of the function body).
2. New equivalence-test cases in `tests/issue-1169e-string.test.ts`:
   - empty string
   - single-char string
   - multi-char string with simple body
   - string concatenation inside body (mixes slice-1 string ops with
     slice-6 for-of)
3. No regressions in existing IR tests.
4. CI test262 net delta ≥ 0.

## Sub-issue of

\#1169 — IR Phase 4: full compiler migration

## Implementation Summary

Landed via PR #71. Adds string fast-path for-of through IR, routing `for (const c of "hello")` through the iterator-protocol arm in host-strings mode and a native `__str_charAt` counter loop in native-strings mode. CI: +31 pass (27020→27051), 94 compile_timeout drift regressions confirmed unrelated (Math.hypot, Object.getOwnPropertyDescriptor, RegExp — completely different categories).
