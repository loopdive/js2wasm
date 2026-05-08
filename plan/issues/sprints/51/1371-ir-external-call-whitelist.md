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

## Implementation (slice 1, PR #TBD)

Scope of slice 1: **unary `Math.*` ops with direct Wasm equivalents**.

### Changes

1. **`src/ir/nodes.ts`** — extended `IrUnop` with five new tags: `f64.abs`,
   `f64.sqrt`, `f64.floor`, `f64.ceil`, `f64.trunc`. The lowerer's `case
   "unary"` arm in `src/ir/lower.ts:768` already passes `instr.op` through
   verbatim, so no changes there.

2. **`src/ir/select.ts`**
   - Added `IR_MATH_UNARY_WHITELIST` (`abs`, `sqrt`, `floor`, `ceil`, `trunc`)
     and `mathUnaryToIrOp(name)` mapper.
   - `isPhase1Expr` — when the call shape is `Math.<name>(arg)` and `name` is
     in the whitelist with a single non-spread arg, accept the shape without
     trying to lower `Math` as a receiver (which would fail the in-scope check).
   - `buildLocalCallGraph` — same whitelist guard, so the call-graph closure
     does not flag the function as `external-call`.

3. **`src/ir/from-ast.ts`** — `lowerMethodCall` recognises `Math.<whitelisted>`
   BEFORE attempting to lower the receiver and emits `emitUnary(irOp, arg, f64)`
   directly. An unsupported `Math.<X>` falls through to a clean
   "not in IR whitelist" error so the function routes to legacy.

### What's NOT in this PR (deferred follow-ups)

- `Math.round` — JS's spec rounds half-to-positive-infinity; Wasm's
  `f64.nearest` rounds to even. Not 1:1, would change semantics.
- `Math.min` / `Math.max` / `Math.pow` — binary, would need an `IrBinop`
  extension. `f64.min` / `f64.max` are direct, but `pow` needs a host
  import. Tracked as a phase-2 of this issue.
- `parseInt` / `parseFloat` / `isNaN` / `isFinite` — bare-identifier
  callees. Need a separate path because they aren't `PropertyAccess`-shape
  and they need result-type widening (`parseInt` returns f64, `isNaN`
  returns bool). Phase 3.
- `console.log` / `console.warn` — side-effect-only callees, no return
  value. Need void-position support in the IR shape. Phase 4.

## Test Results

- `tests/equivalence/issue-1371.test.ts` — 5 cases, all pass
  (magnitude returns 5/13/√16, WAT contains `f64.sqrt` and no `Math_sqrt`
  host import, all four whitelisted unaries, non-whitelisted Math fns
  still work via legacy, nested compositions).
- `tests/equivalence/math-builtins.test.ts`,
  `tests/equivalence/math-constants.test.ts`,
  `tests/equivalence/math-pow-coercion.test.ts` — all pass on branch
  (`math-pow-test262-pattern.test.ts` has 1 pre-existing failure that
  reproduces identically on `main`).
- `tests/equivalence/ir-slice4-classes.test.ts`,
  `tests/equivalence/ir-slice10-{arraybuffer-dataview,typed-array,error}.test.ts`
  — 21/21 pass.
- `pnpm run check:ir-fallbacks` — gate green, no unintended bucket increase.

### Acceptance criteria status

- ✅ #1: `magnitude(x, y) { return Math.sqrt(x*x + y*y); }` is IR-claimed
  and emits `f64.sqrt` (verified by WAT regex assertion in the test).
- ⏳ #2: `parseInt(s, 10)` — out of slice-1 scope; tracked as phase 3.
- ⏳ #3: `external-call` count drops ≥50% — playground baseline currently
  has 0 `external-call` entries (the IR fallback budget tracks
  `playground/examples/*.ts`, none of which trigger Math.* calls today).
  This slice unblocks future code that *would* be rejected; the equivalence
  test suite confirms behaviour parity for the new Math.* ops.
- ✅ #4: All existing equivalence tests continue to pass (modulo 1
  pre-existing failure unrelated to this PR).
