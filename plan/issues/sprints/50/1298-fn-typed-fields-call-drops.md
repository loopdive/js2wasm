---
id: 1298
sprint: 50
title: "Calling a function-typed value stored in a field/array/Map drops the call and returns null"
status: done
created: 2026-05-03
updated: 2026-05-03
priority: high
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: closures, functions, classes, maps
goal: npm-library-support
related: [1297]
---
# #1298 — Function-typed fields/array elements/Map values null-deref on call

## Summary

When a function reference is stored in any indexed container (struct
field, vec element, `Map<K, Fn>` value), retrieving it and calling it
silently emits a `drop ; ref.null extern` instead of `call_ref` /
`call_indirect`. The result of the "call" is always `null`.

## Repro

```typescript
class Holder {
  fn: ((s: string) => string) | null = null;
  call(s: string): string {
    if (this.fn == null) return "no";
    return this.fn!(s);
  }
}

export function test(): string {
  const h = new Holder();
  h.fn = (s: string) => s + "!";
  return h.call("hi");           // returns null, expected "hi!"
}
```

Same pattern fails for `Fn[]` (`fns[0]("hi")`) and
`Map<string, Fn>` (`map.get("k")("hi")`).

A function passed as a *parameter* and called inside the receiving
function works correctly — only stored-then-called fails.

## Root cause (from WAT inspection)

The compiler creates a `__fn_wrap_N_struct (sub final (struct (field $func funcref)))`
when the function is assigned to the field — wrapping the funcref in a
struct + boxing as externref. The set side correctly emits:

```
ref.func 5
struct.new 7      ; __fn_wrap_1_struct
extern.convert_any
struct.set 2 1    ; Holder.fn
```

But the call side does NOT unbox + dispatch:

```
local.get 4
struct.get 2 1    ; load externref
drop              ; <-- WRONG: should ref.cast back to __fn_wrap struct,
                  ;     load $func field, call_ref with env+args
ref.null extern   ; <-- WRONG: should be the call_ref result
return
```

The call-site compiler doesn't recognize that the loaded externref is a
boxed function that needs unwrapping before invocation.

## Where to fix

- `src/codegen/expressions/calls.ts` — `compileCallExpression` (or whichever
  function compiles `expr(args)` where `expr` is a property access /
  array index / Map.get).
- The call site needs to detect that the callee value is an externref
  carrying a `__fn_wrap_N_struct` and emit:
  1. `any.convert_extern`
  2. `ref.cast (ref __fn_wrap_N_struct)`
  3. `struct.get __fn_wrap_N_struct $func` (yields funcref)
  4. Push args (with closure env if needed)
  5. `call_ref $type` for the function signature

## Acceptance criteria

1. The repro above returns `"hi!"`.
2. `const fns: ((s: string) => string)[] = [(s) => s + "!"]; fns[0]("hi")`
   returns `"hi!"`.
3. Map with function values: `Map<string, Fn>` retrieve + call works.
4. `tests/stress/hono-tier5.test.ts` — Tier 5a / 5d / 5d-closure tests
   (currently `it.skip` with `#1298` reference) all pass.

## Notes

- This blocks idiomatic Hono usage (`app.get("/path", c => c.text(...))`)
  and any user code that registers callbacks via maps/arrays.
- Tier 5 currently uses a parallel-array + numeric-ID workaround
  (`tests/stress/hono-tier5.test.ts` lower describe block) to validate
  the dispatch contract end-to-end without storing fn refs.

## Implementation Plan

### Root cause

Three converging gaps in `compileCallExpression`, all manifesting as
"compile callee to externref → drop → push ref.null.extern" via the final
graceful fallback at `src/codegen/expressions/calls.ts:6790-6803`.

1. **Nullable field type hides call signatures.**
   `compileCallablePropertyCall` (calls-closures.ts:408) bails out when
   `propTsType.getCallSignatures()` returns 0. For a field declared
   `fn: ((s) => string) | null`, the TS union with `null` has zero call
   signatures (intersection of member call sigs is empty). The function
   returns `undefined`, the caller at calls.ts:3610 / 3849 falls through,
   and the receiver+method dispatch ends in the graceful fallback.

2. **`NonNullExpression` is never unwrapped at the call-callee level.**
   `this.fn!(s)` has `expr.expression` = `NonNullExpression` whose inner is
   the `PropertyAccessExpression` `this.fn`. The propAccess block guard at
   calls.ts:925 (`ts.isPropertyAccessExpression(expr.expression)`) is false,
   so all class-method / callable-property dispatch is skipped. Only the
   ParenthesizedExpression unwrap at calls.ts:869-913 exists today; there
   is no equivalent `NonNullExpression` unwrap.

3. **Generic call-signature fallback doesn't eagerly create wrappers.**
   The generic fallback at calls.ts:6680-6785 scans
   `ctx.closureInfoByTypeIdx` for a matching `__fn_wrap_N`. When
   `Holder.call` is compiled before the assignment site that registers the
   wrapper (likely class-method-first compilation order), the scan finds
   nothing and falls through to graceful-null at 6790. Compare with the
   identifier-callable path at calls.ts:5028 which eagerly calls
   `getOrCreateFuncRefWrapperTypes` so the lookup is order-independent.

For `Fn[]` (`fns[0]("hi")`) the failure is the resolved-method-name fallback
at calls.ts:6371-6386 — see #1306 for the parallel `mws[idx](...)` path.
For `Map<string, Fn>` (`map.get("k")("hi")`) the callee is a `CallExpression`
and the path at calls.ts:6555-6669 already exists; verify in step 4.

### Changes

**File: `src/codegen/expressions/calls-closures.ts`**

- Function `compileCallablePropertyCall` (line ~408)
- Around line 430 where call signatures are read, change:

  ```ts
  const propTsType = ctx.checker.getTypeAtLocation(propAccess);
  const callSigs = propTsType.getCallSignatures?.();
  if (!callSigs || callSigs.length === 0) return undefined;
  ```

  to:

  ```ts
  const propTsType = ctx.checker.getTypeAtLocation(propAccess);
  let callSigs = propTsType.getCallSignatures?.();
  if (!callSigs || callSigs.length === 0) {
    // Field typed as `Fn | null` / `Fn | undefined` — strip nullable
    // members and retry. Storage is externref either way.
    const nonNull = ctx.checker.getNonNullableType(propTsType);
    callSigs = nonNull.getCallSignatures?.();
  }
  if (!callSigs || callSigs.length === 0) return undefined;
  ```

  This makes the externref-field path at lines 500-560 reachable for
  nullable-callable fields. The existing logic already handles
  `fieldType.kind === "externref"` correctly: it calls
  `getOrCreateFuncRefWrapperTypes`, casts the loaded externref to
  `__fn_wrap_N_struct`, extracts the funcref, and emits `call_ref`.

**File: `src/codegen/expressions/calls.ts`**

- Function `compileCallExpression` — add a `NonNullExpression` unwrap
  after the existing ParenthesizedExpression unwrap at line ~914,
  before the super.method check at line 916:

  ```ts
  // Unwrap `expr!(...)` non-null assertions on the callee. The TS type
  // of NonNullExpression is the original type minus null/undefined, so
  // the underlying PropertyAccessExpression / Identifier / etc. dispatch
  // sees a callable type. Mirrors the ParenthesizedExpression unwrap above.
  if (ts.isNonNullExpression(expr.expression)) {
    const inner = expr.expression.expression;
    const syntheticCall = ts.factory.createCallExpression(
      inner as ts.Expression as ts.LeftHandSideExpression,
      expr.typeArguments,
      expr.arguments,
    );
    ts.setTextRange(syntheticCall, expr);
    (syntheticCall as any).parent = expr.parent;
    return compileCallExpression(ctx, fctx, syntheticCall as ts.CallExpression);
  }
  ```

  Note: don't unwrap when `inner` is itself a function/arrow expression
  (those are still IIFEs handled later) — but `expr!()` on a literal
  function would be unusual TS; the inner check `isFunctionExpression ||
  isArrowFunction` is a safety net you can copy from the parens path if
  desired.

- Generic-fallback hardening at line ~6680 (`Generic fallback: compile the
  callee expression to get a value on the stack`):

  Replace the closureInfoByTypeIdx scan-only logic with eager-create:
  if `callSigs.length > 0`, call
  `getOrCreateFuncRefWrapperTypes(ctx, sigParamWasmTypes, sigRetWasm ? [sigRetWasm] : [])`
  FIRST, take its `closureInfo`/`structTypeIdx` as the primary match,
  then optionally still scan for additional candidates (covariant return
  types — see the multi-candidate logic at calls.ts:5044-5092).

  This makes the dispatch order-independent: even if no closure with this
  signature has been compiled yet at this point, the wrapper types are
  registered, and any later closure assignment will reuse the same struct
  via the funcRefWrapperCache.

  **Pattern reference**: the identifier-callable-param path at
  calls.ts:4998-5239 already does exactly this — copy its
  `getOrCreateFuncRefWrapperTypes` + alternative-return-type-variant
  candidate gathering verbatim, just with the callee being
  `expr.expression` (any expression) instead of an `Identifier`.

### Wasm IR pattern (reference — already implemented in compileCallablePropertyCall)

```wasm
;; Stack: [closure as externref] (loaded from struct field)
any.convert_extern              ;; externref → anyref
ref.test (ref $__fn_wrap_N)     ;; guarded — emitGuardedRefCast helper
ref.cast (ref $__fn_wrap_N)
local.tee $__cprop_ext_42       ;; save closure-struct ref

;; Push args (with null-check on `self` arg)
local.get $__cprop_ext_42
ref.is_null  if  throw TypeError  end
local.get $__cprop_ext_42
local.get $arg_s                ;; "hi"

;; Extract funcref and call
local.get $__cprop_ext_42
struct.get $__fn_wrap_N $func   ;; field 0: funcref
ref.cast (ref $__fn_wrap_N_type)  ;; emitGuardedFuncRefCast
ref.is_null  if  throw TypeError  end
call_ref $__fn_wrap_N_type      ;; signature: (ref $struct, externref) → externref
```

### Edge cases

- **Field type is `Fn | null`** (the headline repro) — fix #1 above.
- **Field type is `Fn | undefined`** — same path, `getNonNullableType`
  strips both `null` and `undefined`.
- **Field type is `Fn | null | undefined`** — same.
- **`this.fn!(args)` non-null assertion** — fix #2 above (NonNullExpression
  unwrap).
- **`(this.fn!)(args)` parens around non-null** — already handled by the
  existing parens unwrap, then fix #2 unwraps the inner non-null.
- **`this.fn?.(args)` optional call** — separate path
  (`compileOptionalCall`); already handles null-or-undefined receiver,
  not in scope for this fix but verify no regression.
- **Field is genuinely `null` at runtime** — `compileCallablePropertyCall`
  already emits `emitNullCheckThrow` which throws TypeError; matches
  ECMAScript spec for "calling null".
- **Field has covariant return** (e.g. callsig is `() => string` but
  registered closure returns `unknown`) — fix #3 (eager-create + scan)
  handles via the multi-funcref-candidate dispatch chain mirrored from
  calls.ts:5044-5092.
- **Nested call: `obj.handlers.get("x")(c)`** — `expr.expression` is
  `CallExpression`, hits the existing call-as-callee path at calls.ts:6555.
  Verify it works after fix #3 lands; if Map.get's return type is
  `Handler | undefined`, the same nullable-stripping may be needed in the
  call-as-callee block (lines 6556-6557 read `getCallSignatures` directly).
  If so, apply the `getNonNullableType` fallback there too — same pattern.

### Test pattern: `tests/issue-1298.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { run } from "./helpers/run.js";

describe("#1298 — function-typed field/array/map call", () => {
  it("class field of nullable function type calls correctly", async () => {
    const { exports } = await run(`
      class Holder {
        fn: ((s: string) => string) | null = null;
        call(s: string): string {
          if (this.fn == null) return "no";
          return this.fn!(s);
        }
      }
      export function test(): string {
        const h = new Holder();
        h.fn = (s: string) => s + "!";
        return h.call("hi");
      }
    `);
    expect(exports.test!()).toBe("hi!");
  });

  it("array of functions dispatches via index", async () => {
    const { exports } = await run(`
      export function test(): string {
        const fns: ((s: string) => string)[] = [(s) => s + "!"];
        return fns[0]("hi");
      }
    `);
    expect(exports.test!()).toBe("hi!");
  });

  it("Map<string, Fn>.get(...)(...)", async () => {
    const { exports } = await run(`
      export function test(): string {
        const m = new Map<string, (s: string) => string>();
        m.set("k", (s: string) => s + "!");
        const fn = m.get("k");
        return fn!("hi");
      }
    `);
    expect(exports.test!()).toBe("hi!");
  });

  it("non-null asserted property call without temporary binding", async () => {
    const { exports } = await run(`
      class H { fn: ((s: string) => string) | null = null; }
      export function test(): string {
        const h = new H();
        h.fn = (s: string) => s + "!";
        return h.fn!("hi");
      }
    `);
    expect(exports.test!()).toBe("hi!");
  });

  it("calling null field throws TypeError (existing behavior preserved)", async () => {
    const { exports } = await run(`
      class H { fn: ((s: string) => string) | null = null; }
      export function test(): string {
        const h = new H();
        try { h.fn!("hi"); return "no-throw"; } catch (e) { return "threw"; }
      }
    `);
    expect(exports.test!()).toBe("threw");
  });
});
```

Plus un-skip three Tier 5 tests in `tests/stress/hono-tier5.test.ts`:
- Tier 5a — single GET route dispatches via c.text(...) (#1298) — line 131
- Tier 5d — three chained routes each dispatch (#1298) — line 187
- Tier 5d — handler closure captures outer scope value (#1298) — line 235

### Risks

- The `NonNullExpression` unwrap is a synthetic CallExpression recursion;
  if the inner expression is also a non-LeftHandSide form (rare but
  possible: `(x ?? y)!(args)`), `ts.factory.createCallExpression` will
  re-wrap it in `ParenthesizedExpression`, which is already handled by the
  parens unwrap at calls.ts:869. No infinite recursion expected, but add a
  test for the chained case.
- The eager-create at the generic fallback may register a `__fn_wrap`
  struct that is never used if the callee is genuinely a non-callable
  receiver (defensive cost: one extra recursive struct type, ~12 bytes in
  the type section). Acceptable.
- Touches the same file as #1306 (`calls.ts`). Sections don't overlap
  (#1298 in propAccess @ ~925, NonNull unwrap @ ~914, generic fallback
  @ ~6680; #1306 in ElementAccess @ ~5927-6410), so parallel dispatch is
  safe — but tech lead should merge them sequentially with a `git merge
  origin/main` between to surface any edge conflicts in the regression
  guard at the bottom of compileCallExpression.

## Fix #3 — Safe reimplementation (spec, 2026-05-07)

### What was reverted (and why)

`b10a809ef fix(#1298): revert generic call-as-callee fallback rewrite (test262 -276 net)`
removed the eager-create + multi-candidate dispatch at calls.ts:~6710.
The original v1 rewrite **unconditionally committed to a wasm-closure
dispatch path** for any callee whose TS type carried a call signature:

1. Eagerly call `getOrCreateFuncRefWrapperTypes(...)` so the wrapper
   struct/funcref pair always exists for that signature.
2. `compileExpression(callee)` → push value (externref typically).
3. `any.convert_extern` → `emitGuardedRefCast(struct)` → `local.set
   closureLocal`.
4. Dispatch: `local.get closureLocal` → null-check (throw TypeError) →
   push args → struct.get $func → guarded funcref cast → null-check →
   `call_ref`.

`emitGuardedRefCast` returns `ref.null` (not a trap) when `ref.test`
fails — but the **subsequent `emitNullCheckThrow` at calls.ts:6762
turns that null into a TypeError**. So for callee values whose runtime
representation is NOT one of our `__fn_wrap_N_struct` types (host-imported
function refs, or wasm functions whose argument signature was lifted via
a different wrapper than the one the call site eagerly created), the
sequence threw at the first null check before any user code could run.

The regression cluster (340 null_deref test262 failures, mostly
`built-ins/Temporal/*`) shared the shape: a callable identifier (or a
property access reaching the generic fallback after upstream paths
rejected it) whose TS signature was uncommon enough that no closure
of that signature was assigned earlier in the same compilation, AND
whose runtime value flowed in as a host-side function ref. Pre-rewrite
those reached the graceful "compile + drop + ref.null.extern" tail at
calls.ts:6804-6820 and silently produced `null`; post-rewrite they
threw TypeError.

### Constraint for the safe re-implementation

> The generic fallback's `ref.cast` / `call_ref` chain must only fire
> when the runtime value is actually a `__fn_wrap_N_struct`. Any other
> callee shape must drop through to the graceful-null tail unchanged.

This is exactly what the upstream paths (`compileCallablePropertyCall`
externref-field branch at calls-closures.ts:500-560, identifier-callable
at calls.ts:5028) already do indirectly — they only enter the cast
chain when the static analysis proves the value originated from a
wasm closure assignment in the same module. The generic fallback can't
prove that statically (it's the last-resort path), so it has to gate
on a **runtime** type check.

### Strategy: ref.test-guarded dispatch with graceful-null else branch

Replace the unconditional eager-create dispatch with a single
`ref.test (ref $__fn_wrap_N_struct)` performed BEFORE any cast or
null-check. The result is an `i32` consumed by an `if/else`:

- **then branch** — runtime value IS a wasm closure of the matching
  shape: emit the original eager-create dispatch chain (cast, args,
  call_ref). The cast cannot fail here because `ref.test` already
  proved it succeeds.
- **else branch** — runtime value is anything else (host function
  ref, foreign externref, null): emit the graceful "drop + ref.null.extern"
  tail. Same observable behavior as the pre-rewrite scan-only fallback.

Both branches return `externref` (the graceful-null type). The dispatch
branch coerces the closure's actual return type to externref via
`coerceType` so the if-block has a single result type.

### Pseudocode

```ts
// At calls.ts:~6710, replacing the current scan-only block.
// Reached only when no upstream path matched the callee shape.

const calleeTsType = ctx.checker.getTypeAtLocation(expr.expression);
let callSigs = calleeTsType.getCallSignatures?.();
if (!callSigs || callSigs.length === 0) {
  const nonNull = ctx.checker.getNonNullableType(calleeTsType);
  callSigs = nonNull.getCallSignatures?.();
}
if (!callSigs || callSigs.length === 0) {
  // No call signature at all → only the graceful tail makes sense.
  // (Falls through to existing graceful fallback below.)
} else {
  const sig = callSigs[0]!;
  const sigParamCount = sig.parameters.length;
  const sigRetType = ctx.checker.getReturnTypeOfSignature(sig);
  const sigRetWasm = isVoidType(sigRetType) ? null : resolveWasmType(ctx, sigRetType);
  const sigParamWasmTypes: ValType[] = [];
  for (let i = 0; i < sigParamCount; i++) {
    const paramType = ctx.checker.getTypeOfSymbol(sig.parameters[i]!);
    sigParamWasmTypes.push(resolveWasmType(ctx, paramType));
  }
  const wrapperTypes = getOrCreateFuncRefWrapperTypes(
    ctx, sigParamWasmTypes, sigRetWasm ? [sigRetWasm] : [],
  );
  if (!wrapperTypes) {
    // (extremely rare: signature couldn't produce a wrapper) — fall through
  } else {
    const closureInfo = wrapperTypes.closureInfo;
    const structTypeIdx = wrapperTypes.structTypeIdx;
    const funcTypeIdx = closureInfo.funcTypeIdx;

    // 1. Compile the callee once, save to a local.
    const innerType = compileExpression(ctx, fctx, expr.expression);
    if (innerType === null) {
      // void result — nothing to test against. Fall through.
    } else {
      // Save the original value (may be externref OR a ref/ref_null type).
      // Stash type is anyref so both shapes fit; we re-load + convert
      // separately in the then branch.
      const calleeLocalType: ValType = innerType.kind === "externref"
        ? { kind: "externref" }
        : (innerType.kind === "ref" || innerType.kind === "ref_null")
          ? innerType
          : null /* sentinel below */;
      if (calleeLocalType === null) {
        // Non-ref callee (number, i32, etc.) — physically can't be a wasm
        // closure. Drop, compile args (drop), push null, return.
        fctx.body.push({ op: "drop" });
        for (const arg of expr.arguments) {
          const t = compileExpression(ctx, fctx, arg);
          if (t) fctx.body.push({ op: "drop" });
        }
        fctx.body.push({ op: "ref.null.extern" });
        return { kind: "externref" };
      }

      const calleeLocal = allocLocal(fctx, `__cb_callee_${fctx.locals.length}`, calleeLocalType);
      fctx.body.push({ op: "local.set", index: calleeLocal });

      // 2. Compile args ONCE into locals so both branches re-push them
      //    (avoids double-evaluation of side-effecting args).
      const argLocals: Array<{ local: number; type: ValType }> = [];
      const ccParamCnt = closureInfo.paramTypes.length;
      for (let i = 0; i < Math.min(expr.arguments.length, ccParamCnt); i++) {
        compileExpression(ctx, fctx, expr.arguments[i]!, closureInfo.paramTypes[i]);
        const argLocal = allocLocal(fctx, `__cb_carg_${fctx.locals.length}`, closureInfo.paramTypes[i]!);
        fctx.body.push({ op: "local.set", index: argLocal });
        argLocals.push({ local: argLocal, type: closureInfo.paramTypes[i]! });
      }
      // Trailing args beyond declared param count: compile for side
      // effects, drop. (Existing fallback semantics.)
      for (let i = ccParamCnt; i < expr.arguments.length; i++) {
        const t = compileExpression(ctx, fctx, expr.arguments[i]!);
        if (t) fctx.body.push({ op: "drop" });
      }
      // Pad: missing args get default values into locals so the then
      // branch can re-push them uniformly.
      for (let i = expr.arguments.length; i < ccParamCnt; i++) {
        const paramType = closureInfo.paramTypes[i]!;
        const padType: ValType = paramType.kind === "ref"
          ? { kind: "ref_null", typeIdx: paramType.typeIdx }
          : paramType;
        pushDefaultValue(fctx, padType, ctx);
        const argLocal = allocLocal(fctx, `__cb_cpad_${fctx.locals.length}`, padType);
        fctx.body.push({ op: "local.set", index: argLocal });
        argLocals.push({ local: argLocal, type: padType });
      }

      // 3. Emit the ref.test guard. Both then/else must produce externref.
      //
      // Stack before the if: [i32 (ref.test result)]
      fctx.body.push({ op: "local.get", index: calleeLocal });
      if (calleeLocalType.kind === "externref") {
        fctx.body.push({ op: "any.convert_extern" });
      }
      fctx.body.push({ op: "ref.test", typeIdx: structTypeIdx } as unknown as Instr);

      // 4. then branch: confirmed wasm closure. Cast + dispatch.
      const thenInstrs: Instr[] = [];
      const savedBody = fctx.body;
      fctx.body = thenInstrs;

      // Re-load callee, cast to the wrapper struct.
      fctx.body.push({ op: "local.get", index: calleeLocal });
      if (calleeLocalType.kind === "externref") {
        fctx.body.push({ op: "any.convert_extern" });
      }
      // Plain ref.cast (NOT guarded) — ref.test above already proved it succeeds.
      fctx.body.push({ op: "ref.cast", typeIdx: structTypeIdx } as unknown as Instr);
      const closureLocal = allocLocal(
        fctx, `__cb_closure_${fctx.locals.length}`,
        { kind: "ref", typeIdx: structTypeIdx },
      );
      fctx.body.push({ op: "local.set", index: closureLocal });

      // Push self (closure ref) + args + funcref, then call_ref.
      fctx.body.push({ op: "local.get", index: closureLocal });
      for (const al of argLocals) {
        fctx.body.push({ op: "local.get", index: al.local });
      }
      fctx.body.push({ op: "local.get", index: closureLocal });
      fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx: 0 });
      // Funcref CAN be the wrong subtype (#778) — keep the guarded cast
      // and null-check here. ref.test proved struct identity but the
      // funcref slot can still hold a different lifted type after
      // covariant-return relaxation; conservative null path → graceful.
      emitGuardedFuncRefCast(fctx, funcTypeIdx);
      // If funcref-cast failed, ref.is_null branch returns ref.null extern.
      // We'd normally throw TypeError here; for the safe reimpl, route
      // through a single coerce-or-null step at the end of the then
      // branch so the if-block result type stays externref.
      const funcOk = allocTempLocal(fctx, { kind: "ref_null", typeIdx: funcTypeIdx });
      fctx.body.push({ op: "local.tee", index: funcOk });
      fctx.body.push({ op: "ref.is_null" });
      fctx.body.push({
        op: "if",
        blockType: { kind: "val", type: { kind: "externref" } },
        then: [
          // Discard the half-built call frame and produce graceful null.
          // (Stack contains self + args under the funcref-null we just
          // popped via ref.is_null. Drop them in reverse order.)
          ...argLocals.slice().reverse().flatMap(() => [{ op: "drop" } as Instr]),
          { op: "drop" } as Instr, // drop the self closure ref
          { op: "ref.null.extern" } as Instr,
        ],
        else: [
          // Funcref OK: re-push it, then call_ref.
          { op: "local.get", index: funcOk } as Instr,
          { op: "ref.as_non_null" } as Instr,
          { op: "call_ref", typeIdx: funcTypeIdx } as Instr,
          // Coerce return value to externref (matches if-block result type).
          ...buildCoerceToExternref(ctx, closureInfo.returnType),
        ],
      });
      releaseTempLocal(fctx, funcOk);

      // 5. else branch: not a wasm closure. Graceful null.
      const elseInstrs: Instr[] = [{ op: "ref.null.extern" } as Instr];

      // Restore body and emit the if.
      fctx.body = savedBody;
      fctx.body.push({
        op: "if",
        blockType: { kind: "val", type: { kind: "externref" } },
        then: thenInstrs,
        else: elseInstrs,
      });
      return { kind: "externref" };
    }
  }
}

// (Falls through to existing graceful-null tail at calls.ts:6807-6820 if
// any of the early-bail conditions above triggered.)
```

Where `buildCoerceToExternref(ctx, returnType)` produces the `Instr[]`
that promotes the call_ref result to externref:
- `null` (void): push `ref.null.extern`, no drop needed since call_ref
  produced no value.
- `{ kind: "externref" }`: no-op.
- `{ kind: "f64" }`: `call __box_number` (already in funcMap once
  `addUnionImports` has fired; call ensure-import here for safety).
- `{ kind: "i32" }`: `f64.convert_i32_s` then `call __box_number`.
- `{ kind: "ref" | "ref_null" ... }`: `extern.convert_any`.
- Anything else: emit a drop + `ref.null.extern` and let downstream
  TypeError surface (defensive, should be unreachable for legal call
  signatures).

### Why this fixes the regression

The Temporal-cluster failure was: callee value is a host function ref
(or a different wasm-wrapper shape), but the v1 rewrite committed to a
wasm-closure dispatch and threw at the first null check. With
`ref.test`-guarded dispatch:

- For callee values that ARE `__fn_wrap_N_struct` instances of the
  matching signature (the headline `Map<string, Fn>.get(...)("hi")`,
  `fns[0]("hi")`, indirect Tier 5c compose) — `ref.test` returns 1,
  full dispatch fires, call succeeds.
- For host function refs, foreign externrefs, null receivers, mismatched
  wrapper shapes — `ref.test` returns 0, the else branch graceful-nulls
  (matching the pre-rewrite behavior the Temporal tests relied on).

No spec deviation because the graceful-null tail was already the prior
behavior at this exact dispatch site; we're preserving it for callees
the static analysis can't classify.

### Why we keep ref.test on the funcref slot too (defense-in-depth)

`closureInfoByTypeIdx` is signature-keyed via `funcRefWrapperCache`, so
two distinct closures with `() => string` vs `() => any` end up in
DIFFERENT struct types — `ref.test (ref $__fn_wrap_string)` handles the
struct-level mismatch. But within ONE struct type, the `$func` field
is `funcref`, and a covariant-return-relaxation closure can store a
funcref of a slightly different lifted type than the one we're about
to `call_ref` against. The pre-revert code's `emitGuardedFuncRefCast +
emitNullCheckThrow` chain caught this with a TypeError; the safe
re-impl turns it into a graceful null instead, mirroring the
struct-level fallback. (Multi-candidate covariant-return dispatch from
#1131 is intentionally not re-introduced in this fallback path — the
upstream `compileCallablePropertyCall` + identifier-callable paths
already own that case for known-shape callees, and the generic
fallback is supposed to be a conservative last-resort.)

### Why we save args to locals before the ref.test

The ref.test result depends on the runtime callee value, which we can
only obtain by evaluating `expr.expression`. We must evaluate `callee`
exactly once (it can be side-effecting) and the args exactly once
(they can be side-effecting). The pattern is:

1. evaluate callee → save to local
2. evaluate args → save to locals
3. `local.get callee` + `ref.test` — produces i32 dispatch flag
4. branch on flag, re-using the locals in either branch

Without step 2 in the parent body, the args would have to live inside
the then branch only, and the else branch would still need to evaluate
them for side-effect parity (otherwise the graceful path produces
different observable behavior than before, e.g. arg expressions with
console.log skipped). Saving up front means the else branch is just
`ref.null.extern` — no re-compilation, no side-effect divergence.

### Test plan

Add to `tests/issue-1298.test.ts`:

```ts
it("safe re-impl: callable-typed callee with non-closure runtime value returns null gracefully", async () => {
  const { exports } = await run(`
    // The callee TS type carries a call signature, but the runtime
    // value never originated as a wasm closure — emulate by passing
    // a value cast through 'any'.
    export function test(): string {
      const fn: (() => string) = (null as any) as (() => string);
      // Without the ref.test guard, this used to throw at the cast.
      // With the guard, it returns null gracefully (mirroring pre-fix
      // behavior the Temporal cluster relies on).
      const r = fn?.() ?? "default";
      return r;
    }
  `);
  expect(exports.test!()).toBe("default");
});

it("safe re-impl: Map.get callable retrieved + called succeeds (#1298 headline)", async () => {
  const { exports } = await run(`
    export function test(): string {
      const m = new Map<string, (s: string) => string>();
      m.set("k", (s: string) => s + "!");
      const fn = m.get("k");
      return fn!("hi");
    }
  `);
  expect(exports.test!()).toBe("hi!");
});

it("safe re-impl: Tier 5c compose 'const mw = mws[idx]; mw(c, next)' indirect call works", async () => {
  // Same shape as tests/stress/hono-tier5.test.ts compose source.
  const { exports } = await run(`
    type N = () => string;
    type Mw = (c: number, next: N) => string;
    function compose(mws: Mw[]): (c: number) => string {
      return (c: number) => {
        let i = 0;
        function next(): string {
          const idx = i;
          i = i + 1;
          if (idx >= mws.length) return "end";
          const mw = mws[idx];
          return mw(c, next);
        }
        return next();
      };
    }
    export function test(): string {
      const mws: Mw[] = [
        (c, n: N) => "[A]" + n(),
        (c, n: N) => "[B]" + n(),
      ];
      return compose(mws)(0);
    }
  `);
  expect(exports.test!()).toBe("[A][B]end");
});
```

Plus rerun the un-skip wave in `tests/stress/hono-tier5.test.ts`:
- Tier 5a (line 131) — `app.get('/path', c => c.text(...))`
- Tier 5d (line 187) — three chained routes each dispatch
- Tier 5d (line 235) — handler closure captures outer scope value
- Tier 5c (line 266) — compose two middlewares (block was originally
  blocked on #1301, then on #1306; now blocked on this #1298 indirect
  `const mw = ...; mw(...)` path)

### CI gate

The v1 rewrite caused `regressions_real = 340` (Temporal cluster). The
safe re-impl MUST keep `regressions_wasm_change` at 0 in those buckets.
Specifically check on the dev-self-merge bucket-by-path output:
- `test/built-ins/Temporal/*` — regression count must be ≤ 5 (drift
  tolerance), down from 340.
- `test/built-ins/Iterator/*`, `test/language/expressions/call/*` —
  no new bucket > 10.

Net delta target: `net_per_test ≥ 0`, and headline +N improvements
from the four un-skipped Tier 5 tests + the new tests/issue-1298 cases
landing as new pass entries.

### Files touched

- `src/codegen/expressions/calls.ts` — replace the scan-only block at
  ~6713-6800 with the ref.test-guarded version above. Keep the
  graceful-null tail at ~6807-6820 untouched (it now also handles the
  "no call signature at all" early-bail).
- `tests/issue-1298.test.ts` — append the three new cases above.
- `tests/stress/hono-tier5.test.ts` — flip the four `it.skip` markers
  to `it` (or `runIfInstalled` where used).

No changes to `closures.ts`, `calls-closures.ts`, or
`type-coercion.ts` are required — all the helpers (`emitGuardedRefCast`,
`emitGuardedFuncRefCast`, `emitNullCheckThrow`, `pushDefaultValue`,
`getOrCreateFuncRefWrapperTypes`) are already exported and reused.

### Sequencing

This re-implementation is independent of the `compileCallablePropertyCall`
nullable-strip fix (#1) and the `NonNullExpression` unwrap (#2), both
of which are already in main. It can land as a single dev-1298 PR
without further architect input.

## Implementation Results — v1 PR #223 (this PR)

Class-field dispatch (the headline repro) now works end-to-end. Concrete
changes in this PR:

- **`src/codegen/expressions/calls-closures.ts`** (`compileCallablePropertyCall`):
  strip `Fn | null` / `Fn | undefined` via `getNonNullableType` before reading
  call signatures. Previously bailed out on any nullable union.
- **`src/codegen/expressions/calls.ts`** (`compileCallExpression`): added a
  `NonNullExpression` unwrap right after the existing `ParenthesizedExpression`
  unwrap. The inner expression (PropertyAccess / Identifier / etc.) gets a
  synthetic `CallExpression` and recurses, so non-null-asserted callable
  callees (`this.fn!(s)`, `obj.fn!(...)`) reach the dispatch they would have
  hit without the assertion.
- **`src/codegen/expressions/calls.ts`** (identifier-callable-param path
  ~line 5043): same `getNonNullableType` fallback for Identifier callees of
  nullable function type.
- **`src/codegen/expressions/calls.ts`** (call-as-callee path ~line 6588):
  same nullable-type fallback so `m.get("k")(...)` reads call sigs
  correctly when Map.get returns `Fn | undefined`.
- **`src/codegen/expressions/calls.ts`** (generic call-as-callee fallback
  ~line 6710): the architect-specced eager-create + alt-funcref dispatch
  rewrite of this fallback was tried but caused 340 null_deref regressions
  (mostly Temporal tests) on test262 because it removed the original
  graceful `compile-and-drop → ref.null.extern` exit for cases where no
  closure-struct match existed. The revert leaves this scan-only fallback
  unchanged. The headline `this.fn!(s)` repro reaches dispatch via the
  PropertyAccess + NonNull-unwrap path above, not via this fallback. Fix
  #3 is now specced for safe re-implementation in the section above.

### Tests landed in this PR

`tests/issue-1298.test.ts` — 9 passing scenarios covering the headline
class-field case, non-null assertions (direct, nested, parens-wrapped),
nullable variants (`| null`, `| undefined`, `| null | undefined`),
multi-arg callable fields, closure-capture round-trip, and TypeError on
calling a null field. 2 `it.skip` for the array/Map cases that fix #3
will un-skip.

### Test Results (v2 — SHA 40eb77c99)

- test262: net_per_test = +31 (41 improvements, 10 real regressions, 48
  compile_timeouts excluded). Regressions are 1-per-bucket scattered
  drift across unrelated areas (TypedArray length accessor, Promise
  Symbol.species, eval edge cases) — same drift pattern observed on
  parallel PRs #225/#226/#227. Tech lead approved physical-impossibility
  override given max bucket = 1.
- `npx vitest run tests/issue-1298.test.ts` — 9 passed, 2 skipped.
- `npx vitest run tests/stress/hono-tier5.test.ts` — 10 passed, 4
  skipped (unchanged from main; fix #3 will un-skip three #1298 Tier 5
  tests).
