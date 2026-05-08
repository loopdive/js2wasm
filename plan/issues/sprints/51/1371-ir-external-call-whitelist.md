---
id: 1371
sprint: 51
title: "IR: expand external-call whitelist to stop rejecting host imports and Math.*"
status: in-progress
created: 2026-05-08
priority: high
feasibility: medium
reasoning_effort: high
task_type: feature
area: ir, codegen
language_feature: functions
goal: ir-full-coverage
---
# #1371 — IR: external-call whitelist expansion

## Problem

The IR selector rejects any function whose body calls an identifier not declared in the
same source file as `"external-call"` (`src/ir/select.ts:190`):

```typescript
if (trackFallbacks) fallbackReasons.set(name, "external-call");
```

This catches legitimate patterns:
- `Math.abs(x)` — `Math` is not locally declared
- `parseInt(s, 10)` — external global
- Any call to a host import that the compiler registered (`__box_number`, etc.)
- `console.log(...)` — external side-effect

In practice, real-world numeric kernels almost always call at least one of: `Math.sqrt`,
`Math.floor`, `Math.min/max`, `parseInt`, or `isNaN`. Every such function gets rejected and
falls through to the legacy path despite having numeric params and a typed body.

## Root cause

`src/ir/select.ts` function `isExternalCall` (around line 1689) — returns true when the
callee identifier is not in the local `scope` (function params + locals). There is no
whitelist of known-safe externals.

## Implementation plan

### Step 1 — Build a static whitelist

In `src/ir/select.ts`, add a `const WHITELISTED_EXTERNALS = new Set<string>([...])` covering:

**Math methods** (all produce numeric results): `Math.abs`, `Math.ceil`, `Math.floor`,
`Math.round`, `Math.sqrt`, `Math.cbrt`, `Math.pow`, `Math.log`, `Math.log2`, `Math.log10`,
`Math.exp`, `Math.sin`, `Math.cos`, `Math.tan`, `Math.asin`, `Math.acos`, `Math.atan`,
`Math.atan2`, `Math.hypot`, `Math.min`, `Math.max`, `Math.sign`, `Math.trunc`,
`Math.fround`, `Math.clz32`, `Math.imul`.

**Global numeric functions**: `parseInt`, `parseFloat`, `isNaN`, `isFinite`, `Number`,
`Boolean`.

**No-result side effects** (safe to permit): `console.log`, `console.warn`, `console.error`
— these can stay on the legacy expression path but should not cause the *containing function*
to be rejected.

### Step 2 — Wire into external-call detection

In `isExternalCall` (or wherever the `"external-call"` reason is set), before marking as
external: check if the callee `PropertyAccessExpression` text matches `WHITELISTED_EXTERNALS`.
If yes: do NOT reject the function; instead, record the callee as a `requiredExternal` in a
side-set so the lowerer can register the appropriate import.

For `Math.*` calls: the lowerer already has IR nodes for common ops (`IrNode.f64Unary`,
`IrNode.f64Binary`). Extend `from-ast.ts` to lower `Math.floor(x)` → `IrNode.f64Unary {op: "floor", operand}` and similarly for the full set.

For `parseInt`/`parseFloat`: lower to `IrNode.hostCall { name: "__parseInt", args: [...] }` or
a new `IrNode.externCall` that the lowerer maps to the appropriate import.

### Step 3 — Call-graph closure re-run

After the whitelist expansion, re-run `planIrCompilation` on the equivalence test suite with
`trackFallbacks: true`. The `"external-call"` fallback count should drop significantly. Log
the delta and document the remaining rejections — those become the next whitelist extension.

## Acceptance criteria

1. A function `function magnitude(x: number, y: number): number { return Math.sqrt(x*x + y*y); }`
   is claimed by the IR and emits `f64.sqrt` (not a legacy host import call).
2. A function calling `parseInt(s, 10)` is claimed when `s` is the sole string param and the
   return is numeric.
3. `IrFallbackReason "external-call"` count drops by ≥50% against the equivalence test suite.
4. All existing equivalence tests continue to pass.

## Files

- `src/ir/select.ts` — `WHITELISTED_EXTERNALS` set + `isExternalCall` guard
- `src/ir/from-ast.ts` — `Math.*` → IR node lowering (extend `isPhase1Expr` + lowerer)
- `src/ir/nodes.ts` — possibly `IrNode.externCall` for whitelisted host functions

## Notes

Low-risk: the whitelist is conservative (only pure numeric externals). No correctness
regression possible as long as the whitelist excludes side-effectful mutating functions.
