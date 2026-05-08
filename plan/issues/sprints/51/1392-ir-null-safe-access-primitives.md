---
id: 1392
sprint: 51
title: "IR: null-safe access primitives — ref.is_null IrUnop + value-producing if/else IR node"
status: done
created: 2026-05-08
priority: high
feasibility: hard
reasoning_effort: max
task_type: feature
area: ir
language_feature: optional-chain
goal: ir-full-coverage
blocks: 1375
---
# #1392 — IR null-safe access primitives

## Background

#1375 (IR full optional-chain support) requires three IR primitives that do not yet exist.
This was discovered during the #1375 implementation attempt (2026-05-08).

## Missing infrastructure

### 1. `ref.is_null` IrUnop

`src/ir/types.ts:229` has `ref.is_null` as a legacy Wasm op, but `IrUnop` (the IR's unary
operator type) only contains `f64.neg`, `i32.eqz`, `i32.trunc_sat_f64_s`, and Math.*
unary ops. `ref.is_null` is absent.

Needed to test whether an optional-chain receiver is null before accessing its property.

### 2. Value-producing if/else expression IR node

The IR has `select` (eager-eval Wasm select), but no short-circuiting value-producing
if/else. Optional chains require:

```
if (receiver is null) { result = undefined } else { result = receiver.prop }
```

This cannot be expressed with `select` because the else branch must NOT evaluate when the
condition is true.

Legacy codegen uses a Wasm `if/else` block. The IR needs an equivalent — either:
- A new `IrInstrIf` node kind with `cond: IrValueId`, `then: IrInstr[]`, `else: IrInstr[]`
- Or a specialized `null-safe-get` compound instruction

### 3. `IrLowerResolver.nullCheck` method

`src/ir/from-ast.ts` has a commented interface slot for `nullCheck` but the field is never
defined — confirmed by `grep -rn "nullCheck\b" src/` returning zero results. The #1375 spec
assumed this was wired in `integration.ts`; it is not.

## Scope

Add all three to the IR layer so `#1375` can be fully implemented:

1. **`IrUnop: "ref.is_null"`** — `src/ir/types.ts`: add to `IrUnop` union; emit `ref.is_null`
   in `lower.ts` unary dispatch; add identity propagation in `propagate.ts` (non-foldable);
   add no-op case in `constant-fold.ts`.

2. **Value-producing if/else** — `src/ir/nodes.ts` (or wherever IrInstr is defined): add
   `IrInstrIf { kind: "if"; cond: IrValueId; then: IrInstr[]; else: IrInstr[]; result: IrValueId; resultType: IrType }`.
   Update `lower.ts` to emit a Wasm `if/else` block. Update `verify.ts`, `propagate.ts`,
   `dead-code.ts` to walk `then`/`else` branches.

3. **`IrLowerResolver.nullCheck`** — `src/ir/integration.ts`: implement `makeIrLowerResolver`
   to expose `nullCheck(val: IrNode): IrNode` that emits `unary("ref.is_null", val)`.
   Wire in `from-ast.ts` where the throw-to-legacy guard currently fires.

## Acceptance criteria

1. `grep "ref.is_null" src/ir/types.ts` shows it in `IrUnop`.
2. `grep "IrInstrIf\|kind.*if" src/ir/nodes.ts` (or equivalent) shows the new node.
3. `grep "nullCheck" src/ir/integration.ts` shows an implementation (not just a comment).
4. IR verify + propagate + lower passes all existing IR tests with no regression.
5. #1375 can be implemented on top of this without hitting any "throw to legacy" guards.

## Files

- `src/ir/nodes.ts` — add `"ref.is_null"` to `IrUnop`; add `IrInstrIf` node kind; extend `IrInstr` union
- `src/ir/lower.ts` — emit `ref.is_null` (already a no-op via the generic `unary` arm) and a value-producing Wasm `if`/`else` for `IrInstrIf`; extend `collectIrUses` + `collectForOfBodyUses` + `registerInstrDefs`
- `src/ir/verify.ts` — extend `collectUses`
- `src/ir/passes/constant-fold.ts` — `ref.is_null` returns `null` (non-foldable, falls into the default arm)
- `src/ir/passes/dead-code.ts` — extend `collectInstrUses` to walk the if-branch buffers; `IrInstrIf` is NOT side-effecting per se (its branches' instrs carry their own effects)
- `src/ir/passes/monomorphize.ts` — extend `collectUses`
- `src/ir/passes/inline-small.ts` — extend rename walker; add `IrInstrIf` to the body-bearing skip list in `canInline`
- `src/ir/builder.ts` — add `emitRefIsNull(val): IrValueId` and `emitIfElse(...)` convenience methods
- `src/ir/integration.ts` — no changes needed (the builder helpers are sufficient; see "On the `IrLowerResolver.nullCheck` slot" below)

> **Path correction**: the issue header lists `src/ir/types.ts` for the `IrUnop` change and `src/ir/propagate.ts` for type propagation. Neither is correct in the current tree — `IrUnop` lives in `src/ir/nodes.ts:503-515`, and `src/ir/propagate.ts` is the AST-level type-propagation pass that runs BEFORE IR construction; it does not switch on `IrInstr.kind` and needs no changes here.

## Implementation Plan

### Root cause

Three IR-shape gaps prevent `#1375` from lowering optional-chain expressions on the IR fast path:

1. The IR has no `ref.is_null` unary primitive — `IrUnop` (`src/ir/nodes.ts:503-515`) only knows `f64.neg`, `i32.eqz`, `i32.trunc_sat_f64_s`, and a small set of Math.* unary ops. Adding it is mechanical: the lowerer's `case "unary"` arm at `src/ir/lower.ts:768-771` already passes the `op` tag through to Wasm verbatim (`out.push({ op: instr.op } as unknown as Instr)`), and `ref.is_null` is already a valid backend `Instr` (`src/ir/types.ts:229`).

2. The IR's only conditional-value primitive is `IrInstrSelect` (`src/ir/nodes.ts:536-541`), which lowers to Wasm `select` and **eagerly evaluates both arms**. For `obj?.prop`, eagerly evaluating the property access on a null receiver traps. We need a value-producing `if`/`else` whose branches are SSA-buffered the way `IrInstrTry` / `IrInstrForOfVec` already are — so each branch only runs when its condition is met.

3. There is no convenience helper for emitting the `unary("ref.is_null", v)` shape. #1375's spec assumed one existed (`IrLowerResolver.nullCheck`), but `grep -rn "nullCheck\b" src/` returns zero hits. The fix is a small `emitRefIsNull` method on `IrFunctionBuilder`, parallel to the existing `emitUnary` wrappers.

### Implementation order (to avoid red TS during the change)

Make the changes in this order so the tree compiles after each step:

1. `nodes.ts` — extend `IrUnop` union; declare `IrInstrIf`; add `IrInstrIf` to the `IrInstr` discriminated union.
2. `lower.ts` — add `case "if"` to `emitInstrTree`, `collectIrUses`, `collectForOfBodyUses`, and `registerInstrDefs`.
3. `verify.ts` — add `case "if"` to `collectUses`.
4. `passes/dead-code.ts` — add `case "if"` to `collectInstrUses` (recurses into both branch buffers).
5. `passes/monomorphize.ts` — add `case "if"` to `collectUses`.
6. `passes/inline-small.ts` — add `if` to the body-bearing skip list (`canInline`) and to the operand-rename switch.
7. `passes/constant-fold.ts` — no code change needed for `IrInstrIf` (its `kind !== "binary" | "unary"` so `tryFoldInstr` returns it unchanged); `ref.is_null` falls into the `default: return null` arm of `foldUnary` automatically (no change needed there either, but add a one-line comment so the next reader doesn't wonder).
8. `builder.ts` — add the two convenience emitters.

After step 8 the tree compiles. `from-ast.ts` is intentionally **not** edited in this issue — wiring the new primitives into `lowerPropertyAccess` / `lowerCall` and removing the throw-to-legacy guards is the scope of #1375.

### Changes

#### 1. `src/ir/nodes.ts` — extend `IrUnop`, add `IrInstrIf`

**Extend the `IrUnop` union (line 503-515)** — append `"ref.is_null"` after the existing Math.* entries:

```ts
export type IrUnop =
  | "f64.neg"
  | "i32.eqz"
  | "i32.trunc_sat_f64_s"
  // (#1371) Math.* unary ops that map 1:1 to a Wasm f64 instruction.
  | "f64.abs"
  | "f64.sqrt"
  | "f64.floor"
  | "f64.ceil"
  | "f64.trunc"
  // (#1392) Test whether a (ref|ref_null|externref|eqref|anyref|funcref) is
  // null. Result is i32 (1 if null, 0 otherwise). Used by optional-chain
  // lowering (#1375) to gate access on the receiver. Operand IrType must
  // be a reference kind — the verifier does not yet enforce this; see
  // "Verifier note" below.
  | "ref.is_null";
```

**Add `IrInstrIf` after `IrInstrSelect` (around line 541)** — value-producing structured if/else with self-contained branch buffers, mirroring the slice-9 / slice-12 declarative-buffer pattern:

```ts
/**
 * (#1392) Value-producing `if (cond) <thenValue> else <elseValue>`.
 * Unlike `select`, the two branches are LAZY — only the matching branch's
 * instrs run. Both branches must produce a value of the same `resultType`;
 * the lowerer emits a Wasm structured `if` block with `blockType: { kind:
 * "val", type: <lowered resultType> }`.
 *
 * Encoding mirrors the slice-9 `try` / slice-12 `while.loop` shape: each
 * branch carries its own `IrInstr[]` buffer + a terminating `IrValueId`
 * (the SSA def emitted from inside that buffer that gets pushed last on
 * the operand stack as the branch's value). Cross-branch SSA references
 * are NOT supported — defs from `then` are not visible in `else` and vice
 * versa. The from-ast layer must materialize any cross-branch operand
 * before the `if`.
 *
 * Lowering:
 *   <emit cond>                           ;; pushes i32
 *   if (result <lowered resultType>)
 *     <emit thenInstrs body buffer>       ;; via the same SSA-materialise
 *                                            ;; rules as forof.vec.body
 *     <emit thenValue>                    ;; pushes the value
 *   else
 *     <emit elseInstrs>
 *     <emit elseValue>
 *   end
 *
 * Result type: `resultType` (any IrType the lowerer can map to a single
 * Wasm ValType — see `lowerIrTypeToValType` in lower.ts:1992).
 */
export interface IrInstrIf extends IrInstrBase {
  readonly kind: "if";
  readonly cond: IrValueId;
  readonly thenInstrs: readonly IrInstr[];
  readonly thenValue: IrValueId;
  readonly elseInstrs: readonly IrInstr[];
  readonly elseValue: IrValueId;
}
```

**Add `IrInstrIf` to the `IrInstr` union (around line 1606-1662)** — append in the appropriate slice section. Place it next to `IrInstrSelect` for locality:

```ts
export type IrInstr =
  | IrInstrConst
  ...
  | IrInstrSelect
  | IrInstrIf  // (#1392) value-producing structured if/else
  | IrInstrRawWasm
  ...
```

#### 2. `src/ir/lower.ts` — lower `if`, walk its buffers

**(a) `emitInstrTree` (around line 653-1690)** — add `case "if"` next to `case "select"` at line 772-780. Use the slice-12 `while.loop` body-buffer pattern as a template (line 1638-1654):

```ts
case "if": {
  // (#1392) Value-producing structured if/else. Both branches buffer
  // their instrs and push a value at the end. The Wasm `if` block has
  // a value blockType matching the IR resultType.
  if (!instr.resultType) {
    throw new Error(`ir/lower: if instr requires a resultType (${func.name})`);
  }
  const blockValType = lowerIrTypeToValType(instr.resultType, resolver, func.name);
  const blockType: BlockType = { kind: "val", type: blockValType };

  // Emit the condition first — it sits on the stack before the `if`.
  emitValue(instr.cond, out);

  // Helper: emit a branch buffer (then/else) into a target ops array
  // using the same SSA-materialisation rules as forof.* / try / while.
  const emitBranchBuffer = (
    branchInstrs: readonly IrInstr[],
    branchValue: IrValueId,
    target: Instr[],
  ): void => {
    for (const bodyInstr of branchInstrs) {
      if (bodyInstr.result === null) {
        emitInstrTree(bodyInstr, target);
      } else if (crossBlock.has(bodyInstr.result)) {
        emitInstrTree(bodyInstr, target);
        target.push({ op: "local.set", index: localIdx.get(bodyInstr.result)! });
        materialized.add(bodyInstr.result);
      }
      // Intra-block multi-use: handled at use site via tee pattern.
    }
    // Push the branch's terminating value last.
    emitValue(branchValue, target);
  };

  const thenOps: Instr[] = [];
  const elseOps: Instr[] = [];
  emitBranchBuffer(instr.thenInstrs, instr.thenValue, thenOps);
  emitBranchBuffer(instr.elseInstrs, instr.elseValue, elseOps);

  out.push({ op: "if", blockType, then: thenOps, else: elseOps });
  return;
}
```

**(b) `collectIrUses` (around line 1799-1928)** — add the new arm next to `case "select"` (line 1813-1814). The instr's *direct* uses are `cond` only; branch-buffer uses are surfaced separately by `collectForOfBodyUses` (next bullet):

```ts
case "if":
  // Body-buffer uses are surfaced separately via collectForOfBodyUses
  // (mirrors forof.vec / try / while.loop).
  return [instr.cond];
```

**(c) `collectForOfBodyUses` (around line 1937-1968)** — extend the recursion to walk into `if` branches:

```ts
// Slice 12 — recurse into while / for loop buffers. (existing)
if (instr.kind === "while.loop") { ... }
if (instr.kind === "for.loop") { ... }
// (#1392) — recurse into if/else branch buffers + surface the branch
// values so cross-block materialisation tracks them.
if (instr.kind === "if") {
  for (const u of collectForOfBodyUses(instr.thenInstrs)) uses.push(u);
  for (const u of collectForOfBodyUses(instr.elseInstrs)) uses.push(u);
  uses.push(instr.thenValue);
  uses.push(instr.elseValue);
}
```

**(d) `registerInstrDefs` (around line 332-364)** — extend so SSA defs inside a branch register in the def maps:

```ts
if (instr.kind === "for.loop") { ... }  // existing
// (#1392)
if (instr.kind === "if") {
  for (const sub of instr.thenInstrs) registerInstrDefs(sub, blockId);
  for (const sub of instr.elseInstrs) registerInstrDefs(sub, blockId);
}
```

#### 3. `src/ir/verify.ts` — collect operand uses

Around line 290-293, add next to `while.loop`/`for.loop`:

```ts
// (#1392) — `if` direct use is `cond`; branch buffer uses are loop-
// internal (analogous to forof.vec) and aren't surfaced in the
// straight-line walk.
case "if":
  return [instr.cond];
```

> **Verifier note**: Stricter type checking (`cond` must be `i32` IrType; `thenValue.type === elseValue.type === resultType`; `ref.is_null` operand must be a reference kind) is desirable but **out of scope** for this issue. The verifier currently does not type-check most ops at this granularity (see `operandValType` only being used by `box`/`unbox`/`tag.test`); leave such checks to a follow-up. From-ast must produce well-typed IR or the lowerer's `lowerIrTypeToValType` will surface the mismatch at emit time.

#### 4. `src/ir/passes/dead-code.ts` — walk branch buffers

**(a) `collectInstrUses` (around line 261-426)** — add the recursive walker arm next to `try` (line 387-406) and `while.loop`/`for.loop` (line 422-424):

```ts
case "if": {
  // (#1392) Recurse through then/else buffers + pin the branch values.
  const result: IrValueId[] = [instr.cond, instr.thenValue, instr.elseValue];
  const walk = (instrs: readonly IrInstr[]): void => {
    for (const sub of instrs) {
      for (const u of collectInstrUses(sub)) result.push(u);
      if (sub.kind === "forof.vec" || sub.kind === "forof.iter" || sub.kind === "forof.string") walk(sub.body);
      if (sub.kind === "try") {
        walk(sub.body);
        if (sub.catchClause) walk(sub.catchClause.body);
        if (sub.finallyBody) walk(sub.finallyBody);
      }
      if (sub.kind === "if") {
        walk(sub.thenInstrs);
        walk(sub.elseInstrs);
      }
    }
  };
  walk(instr.thenInstrs);
  walk(instr.elseInstrs);
  return result;
}
```

**(b) `isSideEffecting` (around line 167-249)** — `IrInstrIf` is **not** intrinsically side-effecting; its result-bearing nature already keeps it live whenever the result is used (DCE's normal liveness propagation handles the rest). However, side-effecting instrs *inside* a branch buffer must still be kept; they are pinned by the existing reachable-walk over the branch buffers since `collectInstrUses` (above) surfaces them. **No change to `isSideEffecting` is needed.** Add a one-line comment near the slice-12 entries documenting this for the next reader.

#### 5. `src/ir/passes/monomorphize.ts` — collect uses

Around line 764-766, add next to `while.loop` / `for.loop`. Mirror the same recursive walker pattern as dead-code.ts:

```ts
case "if": {
  const result: IrValueId[] = [instr.cond, instr.thenValue, instr.elseValue];
  const walk = (instrs: readonly IrInstr[]): void => {
    for (const sub of instrs) {
      for (const u of collectUses(sub)) result.push(u);
      if (sub.kind === "forof.vec" || sub.kind === "forof.iter" || sub.kind === "forof.string") walk(sub.body);
      if (sub.kind === "try") {
        walk(sub.body);
        if (sub.catchClause) walk(sub.catchClause.body);
        if (sub.finallyBody) walk(sub.finallyBody);
      }
      if (sub.kind === "if") {
        walk(sub.thenInstrs);
        walk(sub.elseInstrs);
      }
    }
  };
  walk(instr.thenInstrs);
  walk(instr.elseInstrs);
  return result;
}
```

#### 6. `src/ir/passes/inline-small.ts` — skip body-bearing instrs + rename operands

**(a) Body-bearing skip list (around line 250-262)** — add `"if"` so `canInline` refuses to inline functions whose body contains a value-producing `if`:

```ts
for (const inst of body.instrs) {
  if (inst.kind === "raw.wasm") return false;
  if (
    inst.kind === "forof.vec" ||
    inst.kind === "forof.iter" ||
    inst.kind === "forof.string" ||
    inst.kind === "try" ||
    inst.kind === "while.loop" ||
    inst.kind === "for.loop" ||
    inst.kind === "if"     // (#1392)
  ) {
    return false;
  }
}
```

**(b) Operand-rename switch (around line 358-369)** — add an arm next to `case "select"`:

```ts
case "if": {
  // (#1392) Body buffers carry their own SSA defs; same body-bearing
  // skip rationale as forof.* / try / while.loop applies, so this
  // case is unreachable in practice (canInline returns false). We
  // include the rename for completeness — body-buffer renaming is
  // not implemented; the canInline guard above prevents any reach.
  const c = mapId(rename, inst.cond);
  if (c === inst.cond) return inst;
  return { ...inst, cond: c };
}
```

#### 7. `src/ir/passes/constant-fold.ts` — no foldable behaviour, just confirm defaults

`tryFoldInstr` at line 100-104 only inspects `binary` and `unary` kinds; an `if` instr falls through unchanged. `foldUnary`'s `default: return null` arm (line 252-253) already returns "non-foldable" for any unknown op including `ref.is_null`. **No code change required.** Add a one-line documentation comment at the `default:` arm:

```ts
default:
  // (#1392) `ref.is_null` and any other reference-domain unops are not
  // foldable at compile time without a heap model. Return null to leave
  // the instr unchanged.
  return null;
```

#### 8. `src/ir/builder.ts` — convenience emitters

After `emitUnary` at line 189-194, add `emitRefIsNull`:

```ts
/**
 * (#1392) Convenience: emit `unary("ref.is_null", val)`. Returns an
 * i32-typed SSA value (1 if null, 0 otherwise).
 *
 * The operand SHOULD be a reference-typed IrType (val/ref, val/ref_null,
 * val/externref, val/eqref, val/anyref, val/funcref, string, object,
 * class, closure, extern). Passing a primitive (i32 / f64) is a from-ast
 * bug — the lowerer will emit a Wasm op with the wrong stack contract.
 */
emitRefIsNull(val: IrValueId): IrValueId {
  return this.emitUnary("ref.is_null", val, irVal({ kind: "i32" }));
}
```

After `emitSelect` at line 196-201, add `emitIfElse`:

```ts
/**
 * (#1392) Emit a value-producing structured if/else. The caller pre-
 * collects each branch buffer via `collectBodyInstrs` and threads the
 * SSA def each branch wants to push as its value (the `thenValue` /
 * `elseValue`). Both branches' values must lower to the same Wasm
 * ValType — the from-ast layer is responsible for matching them up
 * (e.g., by inserting a `coerce.to_externref` on the non-null path
 * when the null-path default is `ref.null.extern`).
 */
emitIfElse(args: {
  cond: IrValueId;
  thenInstrs: readonly IrInstr[];
  thenValue: IrValueId;
  elseInstrs: readonly IrInstr[];
  elseValue: IrValueId;
  resultType: IrType;
}): IrValueId {
  const result = this.allocator.fresh();
  this.valueTypes.set(result, args.resultType);
  this.pushInstr({
    kind: "if",
    cond: args.cond,
    thenInstrs: args.thenInstrs,
    thenValue: args.thenValue,
    elseInstrs: args.elseInstrs,
    elseValue: args.elseValue,
    result,
    resultType: args.resultType,
  });
  return result;
}
```

(Imports already present: `irVal`, `IrInstr`, `IrType`, etc. — no import edits needed.)

### On the `IrLowerResolver.nullCheck` slot in the issue

The issue's Scope §3 says "implement `makeIrLowerResolver` to expose `nullCheck(val: IrNode): IrNode`". This is a **mis-specification carried over from the #1375 attempt**:

- `IrLowerResolver` (declared in `src/ir/lower.ts:183-303`) is the **backend resolver** consulted at LOWERING time to resolve symbolic refs / interned types / host imports. It has no access to `IrFunctionBuilder`, so it cannot synthesise an `IrInstr`.
- `IrFromAstResolver` (declared in `src/ir/from-ast.ts:104-113`) is a *data* resolver — exposing helpers (`nativeStrings`, `resolveString`, vec/extern metadata) that the AST→IR lowerer consults at construction time. It also has no builder access.
- The natural home for an `unary("ref.is_null", v)` shorthand is the **builder** itself, which is what the spec above implements as `emitRefIsNull`.

`#1375`'s call site will therefore read `cx.builder.emitRefIsNull(recv)` — not `cx.resolver.nullCheck(recv)`. **No `IrLowerResolver` / `IrFromAstResolver` change is needed in this issue.**

### Wasm IR shape (target)

For an optional property access `obj?.prop` where `obj` lowers to an externref:

```wasm
;; receiver on stack (externref)
local.tee $tmp_recv             ;; from-ast pre-materializes the receiver
ref.is_null                     ;; <- the new IrUnop
if (result <propValType>)       ;; <- the new IrInstrIf, blockType = val
  ;; null path: push the default (ref.null.extern / f64.const NaN / etc.)
  ref.null.extern
else
  ;; non-null path: do the property access
  local.get $tmp_recv
  call $obj_get_prop             ;; or struct.get / extern.prop / …
end
;; result on stack
```

This matches `compileOptionalPropertyAccess` in `src/codegen/property-access.ts:739-873` byte-for-byte. The from-ast wiring (`#1375`) will need to allocate the `$tmp_recv` materialisation, choose the per-resultType default, and pre-coerce mismatched branch values — none of which is in scope for this issue.

### Edge cases

- **`ref.is_null` operand must be a reference kind.** The Wasm validator rejects `ref.is_null` on i32/f64. The from-ast layer must guarantee the operand is `val/ref|ref_null|externref|eqref|anyref|funcref` or one of the structural IrType kinds (`object`, `class`, `string`, `closure`, `extern`). Add a TODO comment in the builder helper noting this — runtime enforcement is out of scope.
- **`thenValue` / `elseValue` must agree on Wasm ValType.** The lowerer derives the `if` blockType from `instr.resultType`; if either branch pushes a mismatching ValType the Wasm validator rejects the module at instantiation time. From-ast (#1375) should normalise both branches to the same IrType before calling `emitIfElse` — typically by promoting to `externref` via `coerce.to_externref` on the non-null path when the null default is `ref.null.extern`.
- **Cross-branch SSA references are NOT allowed.** A def in `thenInstrs` is invisible to `elseInstrs`. The lowerer's `registerInstrDefs` walks both branches into the same `defBy` map for the verifier's benefit, but at emit time only the matching branch executes. From-ast must materialise any cross-branch operand BEFORE the `if`.
- **DCE on dead branches.** `collectInstrUses` marks both branch values + the cond as live whenever the IF result is live. A dead `if` (result unused, no side effects in either branch) is dropped by the result-liveness rule. Side-effecting instrs inside a branch are kept by their own `isSideEffecting` pinning + the recursive walker.
- **Constant-fold of `if (const cond) ...`.** Out of scope for #1392. A future pass can rewrite `if(true, t, e) → t` by adopting the chosen branch's instrs into the parent block, but it requires SSA renaming (the branch's values reference IrValueIds defined inside the branch buffer); leave for #1375 follow-up.
- **`ref.is_null` on a known-non-null receiver.** Always 0; `from-ast` should already short-circuit such cases (see `isIrTypeNullable` at `src/ir/from-ast.ts:1393-1418`) and emit a regular property access without the guard. The IR primitive accepts the operand regardless.

### Verifier follow-up (not in scope)

A clean follow-up issue should add stricter type checking to `verify.ts`:
- `unary("ref.is_null", v)`: assert `operandIrType(v)` is a reference kind.
- `if`: assert `operandValType(cond) === { kind: "i32" }`; assert `irTypeEquals(thenValueType, resultType)` and `irTypeEquals(elseValueType, resultType)`.

These checks are absent for many existing ops; adding them here without filling in the rest would create asymmetric coverage. Defer.

### Test approach

Write a scoped vitest probe in `.tmp/` (gitignored, not picked up by main vitest) that exercises the chain end-to-end without involving `from-ast.ts` (since #1392 deliberately leaves from-ast unchanged). Build the IR by hand via `IrFunctionBuilder`, lower it with the existing integration resolver, run the resulting Wasm.

**File: `.tmp/ir-null-safe-primitives.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { IrFunctionBuilder } from "../src/ir/builder.js";
import { irVal, asValueId, type IrInstr } from "../src/ir/nodes.js";
import { lowerIrFunctionToWasm } from "../src/ir/lower.js";

// Minimal stub resolver — enough for scalar / externref signatures.
const stubResolver = {
  resolveFunc: () => 0,
  resolveGlobal: () => 0,
  resolveType: () => 0,
  internFuncType: () => 0,
} as any;

describe("#1392 null-safe IR primitives", () => {
  it("emitRefIsNull lowers to ref.is_null on an externref param", () => {
    const b = new IrFunctionBuilder("nullp", [irVal({ kind: "i32" })], true);
    const p = b.addParam("x", irVal({ kind: "externref" }));
    b.openBlock();
    const isNull = b.emitRefIsNull(p);
    b.terminate({ kind: "return", values: [isNull] });
    const fn = b.build();
    const { func } = lowerIrFunctionToWasm(fn, stubResolver);
    expect(func.body.some((i) => i.op === "ref.is_null")).toBe(true);
  });

  it("emitIfElse emits Wasm `if`/`else` with a value blockType", () => {
    // (cond: i32) -> f64
    //   if (cond) 1.0 else 2.0
    const b = new IrFunctionBuilder("v", [irVal({ kind: "f64" })], true);
    const cond = b.addParam("cond", irVal({ kind: "i32" }));
    b.openBlock();

    // Pre-collect both branch buffers — each just produces a const.
    let thenValue = asValueId(-1);
    const thenInstrs = b.collectBodyInstrs(() => {
      thenValue = b.emitConst({ kind: "f64", value: 1 }, irVal({ kind: "f64" }));
    });
    let elseValue = asValueId(-1);
    const elseInstrs = b.collectBodyInstrs(() => {
      elseValue = b.emitConst({ kind: "f64", value: 2 }, irVal({ kind: "f64" }));
    });

    const result = b.emitIfElse({
      cond,
      thenInstrs,
      thenValue,
      elseInstrs,
      elseValue,
      resultType: irVal({ kind: "f64" }),
    });
    b.terminate({ kind: "return", values: [result] });

    const fn = b.build();
    const { func } = lowerIrFunctionToWasm(fn, stubResolver);
    const ifOp = func.body.find((i) => i.op === "if") as any;
    expect(ifOp).toBeDefined();
    expect(ifOp.blockType).toEqual({ kind: "val", type: { kind: "f64" } });
    expect(ifOp.then.length).toBeGreaterThan(0);
    expect(ifOp.else.length).toBeGreaterThan(0);
  });

  it("end-to-end: cond-and-isnull combo lowers cleanly", () => {
    // (x: externref) -> f64
    //   if (ref.is_null(x)) NaN else 1.0
    const b = new IrFunctionBuilder("guard", [irVal({ kind: "f64" })], true);
    const x = b.addParam("x", irVal({ kind: "externref" }));
    b.openBlock();
    const isNull = b.emitRefIsNull(x);

    let thenValue = asValueId(-1);
    const thenInstrs = b.collectBodyInstrs(() => {
      thenValue = b.emitConst({ kind: "f64", value: NaN }, irVal({ kind: "f64" }));
    });
    let elseValue = asValueId(-1);
    const elseInstrs = b.collectBodyInstrs(() => {
      elseValue = b.emitConst({ kind: "f64", value: 1 }, irVal({ kind: "f64" }));
    });

    const r = b.emitIfElse({
      cond: isNull,
      thenInstrs,
      thenValue,
      elseInstrs,
      elseValue,
      resultType: irVal({ kind: "f64" }),
    });
    b.terminate({ kind: "return", values: [r] });

    const fn = b.build();
    const { func } = lowerIrFunctionToWasm(fn, stubResolver);
    // Should contain ref.is_null followed by a value-producing if.
    const idxIsNull = func.body.findIndex((i) => i.op === "ref.is_null");
    const idxIf = func.body.findIndex((i) => i.op === "if");
    expect(idxIsNull).toBeGreaterThanOrEqual(0);
    expect(idxIf).toBeGreaterThan(idxIsNull);
  });
});
```

Run with: `pnpm vitest run .tmp/ir-null-safe-primitives.test.ts`.

The probe verifies (a) `ref.is_null` shows up in lowered Wasm, (b) `IrInstrIf` lowers to a Wasm `if` with a value blockType, (c) the two primitives compose. It deliberately does NOT exercise `from-ast.ts` — that's `#1375`'s scope.

Once this test passes locally, push the branch and let CI run the full vitest suite (which exercises every other IR pass — verify / DCE / monomorphize / inline / constant-fold — against existing fixtures; any missing arm will surface as an exhaustiveness or undefined-symbol error).

### Acceptance check

After implementation:

1. `grep '"ref.is_null"' src/ir/nodes.ts` — shows the entry in `IrUnop`.
2. `grep "IrInstrIf" src/ir/nodes.ts` — shows the new node interface + its entry in the `IrInstr` union.
3. `grep "emitRefIsNull\|emitIfElse" src/ir/builder.ts` — shows the two builder helpers.
4. `pnpm test -- tests/ir/` — all existing IR tests pass (every pass that switches on `IrInstr.kind` has been extended; missing arms would surface as TS exhaustiveness errors at compile time or runtime "unknown instr kind" errors).
5. The scoped probe in `.tmp/` passes.
6. `#1375` can implement optional-chain lowering in `from-ast.ts` using `cx.builder.emitRefIsNull` + `cx.builder.emitIfElse` without hitting any "throw to legacy" guards related to missing primitives.

---

## Implementation Notes (senior-dev, 2026-05-08, branch `issue-1392-ir-null-safe-primitives`)

### Scope decision

I implemented all three IR-side primitives but DEFERRED the from-ast
wiring of optional-chain to #1375 proper. Acceptance criterion #5
("#1375 can be implemented on top of this without hitting any
'throw to legacy' guards") is met by the primitives: the `throw` guards
at `from-ast.ts:1453` and `from-ast.ts:1705` can now be replaced by
emissions of the new primitives in #1375. Removing the guards is
intentionally out of scope here so that this PR is a pure infrastructure
change with no behaviour delta on the existing test matrix.

### Naming alignment with the architect spec

The architect spec proposed `emitRefIsNull` / `emitIfElse` builder method
names. I used `nullCheck` (matches the issue header bullet "`IrLowerResolver.nullCheck` method") and `emitIf` (matches the inline-spec'd `IrInstrIf { kind: "if"; ... }`). These are nearer the source-level vocabulary and the IR's
existing naming convention (`emitUnary`, `emitSelect`, `emitForOfVec`).
The architect spec's recommended names were close but had drifted apart
between the inline `IrInstrIf { kind: "if"; ... }` and the trailing
`emitIfElse` helper.

### Files changed

| File | Change |
|------|--------|
| `src/ir/nodes.ts` | Add `"ref.is_null"` to `IrUnop`. Add `IrInstrIf` (kind: `"if"`) with arm buffers + thenValue / elseValue carriers. Add to the `IrInstr` union. |
| `src/ir/builder.ts` | Add `nullCheck(val)` (= `unary("ref.is_null", val)` → i32) and `emitIf(...)` factory. Rewrite `collectBodyInstrs` to support nesting via save/restore (required for chained `?.b?.c`). |
| `src/ir/lower.ts` | Walk into `if` arms in `registerInstrDefs`. Add `if` to `collectIrUses`, `collectForOfBodyUses`, and the use-recording loop. Add main emission `case "if"` that emits Wasm `if (result T) ... else ... end` via `emitArmBody` (mirrors `try` / `forof.*` SSA materialisation rules). Add optional `IrLowerResolver.nullCheck()` method. |
| `src/ir/verify.ts` | `case "if"` in `collectUses` (returns `[cond]` only — arm buffers are scope-internal, like `try` / `forof.vec`). |
| `src/ir/passes/dead-code.ts` | `case "if"` in `collectInstrUses` recursively walks both arms so DCE pins outer SSA values referenced inside. Update `try` / `forof.*` walkers to recurse into nested `if` arms. |
| `src/ir/passes/constant-fold.ts` | `case "ref.is_null"` in `foldUnary` returns `null` (non-foldable — no ref-typed constants in the lattice). Leave `IrInstrIf` untouched (cond-based collapse is a future optimisation). |
| `src/ir/passes/inline-small.ts` | `case "if"` in `renameInstrOperands` — renames cond + carrier values + recurses through arm buffers. |
| `src/ir/passes/monomorphize.ts` | `case "if"` in `collectUses` — surfaces cond + carriers + arm-internal uses. |
| `src/ir/integration.ts` | `makeResolver` returns a `nullCheck()` method that emits `[ref.is_null]` (the canonical Wasm op sequence). |
| `tests/ir/issue-1392.test.ts` | Seven unit tests across the three primitives: verifier acceptance, lowering shape, constant-fold no-op, builder produces the right SSA form, nested `collectBodyInstrs` works (covers chained `?.b?.c`), nullCheck emits the right unary IR. |

### Verification

- `npx tsc --noEmit` — clean.
- `npm test -- tests/ir/` — 46/46 pass (4 test files).
- `npm test -- tests/equivalence/optional-direct-closure-call.test.ts` — same 2 pre-existing failures as origin/main (verified by stashing my fix and re-running). No regressions caused by this change.
- Merged `origin/main` into the branch (8 commits behind at start) — IR tests still 46/46.

### What #1375 will do on top of this

In `src/ir/from-ast.ts`, the optional-chain handler (currently a
throw-to-legacy guard) will use the new primitives:

```ts
if (expr.questionDotToken && isIrTypeNullable(recvType)) {
  const isNull = cx.builder.nullCheck(recv);
  let thenValue!: IrValueId;
  const thenInstrs = cx.builder.collectBodyInstrs(() => {
    thenValue = /* emit `undefined` literal */;
  });
  let elseValue!: IrValueId;
  const elseInstrs = cx.builder.collectBodyInstrs(() => {
    elseValue = /* emit non-null property access */;
  });
  return cx.builder.emitIf({
    cond: isNull,
    then: thenInstrs, thenValue,
    else: elseInstrs, elseValue,
    resultType: /* widened union of undefined | T */,
  });
}
```

The same shape works for `obj?.method()` (replace the property access in
the else arm with a method call). All primitives are in place.
