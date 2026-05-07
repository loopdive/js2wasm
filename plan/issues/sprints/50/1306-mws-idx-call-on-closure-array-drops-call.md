---
id: 1306
sprint: 50
title: "ElementAccessExpression call on closure-typed array drops call: mws[idx](c, next) emits ref.null"
status: done
created: 2026-05-03
updated: 2026-05-03
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: closures, element-access-call, callable-array
goal: npm-library-support
related: [1301, 1297]
---
# #1306 — `mws[idx](c, next)` on a closure-typed array compiles to `ref.null`, dropping the call

## Background

Surfaced while landing #1301 (closure-env field-type mismatch). With the param
shadowing fix in place, `tests/stress/hono-tier5.test.ts` "Tier 5c — compose:
two middlewares run in registration order" still fails — but for a different
reason than #1301. The compiled binary now validates and instantiates
successfully (the original `struct.new[0]` validation error is gone), but
`exports.test()` returns `null` (or throws) instead of `"[A][B]end"`.

## Reproducer

```typescript
type N = () => string;
type Mw = (c: number, next: N) => string;

function compose(mws: Mw[]): (c: number) => string {
  return (c: number) => {
    let i = 0;
    function next(): string {
      const idx = i;
      i = i + 1;
      if (idx >= mws.length) return "end";
      return mws[idx](c, next);   // <-- compiles to ref.null extern; drop
    }
    return next();
  };
}

export function test(): string {
  return compose([(c, n: N) => "[A]" + n()])(0);  // returns null, expected "[A]end"
}
```

## Root cause (suspected)

Inspecting the WAT for the inner `next` function:

```wat
(func $next ...
  ...
  ;; if (idx >= mws.length) return "end" — emitted correctly
  ;; expected: mws[idx](c, next) call, but actual:
  ref.null extern
  drop
  ref.null extern
  return
)
```

The `mws[idx](c, next)` ElementAccessExpression call resolves to a closure-
typed callable (`Mw = (c, next: N) => string`), but the codegen path for
calling such a value silently emits `ref.null extern` and drops it. Likely
candidates in `src/codegen/expressions/calls.ts`:

- The `ts.isElementAccessExpression(expr.expression)` branch around line 5728
  tries to resolve the element access to a static method name. When the
  receiver is a closure-typed array, `resolvedMethodName` is undefined, and
  control falls through to a path that doesn't dispatch via call_ref.
- The fallback for "element access of unknown method" doesn't synthesize a
  call_ref through the array element when the element type has a TS call
  signature.

## Investigation pointers

- Same file as #1301: `src/codegen/expressions/calls.ts`
- Look at how `obj.method()` resolves callable-typed properties; the array-
  element path likely needs the same treatment with `array[i]` dispatched
  through `__vec_get` + cast + call_ref.
- Note: an inline binding `const mw = mws[idx]; return mw(c, next);` in the
  inner `next` function may work better than the inline `mws[idx](c, next)`
  call. Verify which path the inner function takes (the test source uses the
  inline form).

## Acceptance criteria

1. `mws[idx](c, next)` on a closure-typed array dispatches via call_ref to
   the actual closure stored at index `idx`.
2. Tier 5c "two middlewares run in registration order" test passes
   (`[A][B]end`) without skip marker.
3. Single-mw case with `next()` invocation returns `"[A]end"` (currently
   throws WebAssembly.Exception with #1301 fix applied).

## Files

- `src/codegen/expressions/calls.ts` — element-access call dispatch
- `tests/stress/hono-tier5.test.ts` — un-skip Tier 5c two-mw test after fix

## Why this matters

The middleware-compose pattern is the entire `koa`/`hono` core abstraction.
With #1301 fixed, this is the last gap blocking real array-of-closures
dispatch end-to-end.

## Implementation Plan

### Root cause

`compileCallExpression` in `src/codegen/expressions/calls.ts` handles
`obj[key](args)` calls inside the `ts.isElementAccessExpression(expr.expression)`
branch starting at **line 5927**. Two fallback paths in that branch end in
`drop ; ref.null.extern`:

1. **Resolved-but-unmatched** (line 6371-6386). When the index resolves
   to a static key (literal number/string or compile-time const) but no
   class/struct/string/number/array method matches, the fallback compiles
   the receiver, drops it, drops each argument, and pushes `ref.null.extern`.

2. **Unresolved index** (line 6389-6409). When the index is a runtime
   variable (`mws[idx]` with `idx` a local), `resolveComputedKeyExpression`
   returns undefined, and the entire branch returns through the bottom
   fallback that drops everything and pushes `ref.null.extern`.

Both ignore the case where the receiver is an array/vec whose **element
type has TS call signatures** (i.e. `Mw[]` where `Mw = (c, n) => string`).
There is no path that:

- loads the element via `__vec_get` / `array.get` (returning `externref`),
- unboxes it to a `__fn_wrap_N_struct` ref, and
- emits `call_ref` with the user args.

The reciprocal mechanism for class fields exists in
`compileCallablePropertyCall` (`src/codegen/expressions/calls-closures.ts:408-649`)
— specifically the externref-field branch at lines 500-560 and the
ref-typed-field branch at lines 564-646. The fix mirrors that
implementation for the element-access path.

### Changes

**File: `src/codegen/expressions/calls-closures.ts`**

- Add a new exported helper `compileCallableElementAccessCall` that
  generalises `compileCallablePropertyCall` to vec-struct element access.

  Skeleton:

  ```ts
  /**
   * Handle calls where the callee is a vec/array element access whose
   * element type has TS call signatures: `arr[i](args)`, `arr[const](args)`.
   * Returns undefined to fall through if the receiver isn't a vec of
   * callable values.
   */
  export function compileCallableElementAccessCall(
    ctx: CodegenContext,
    fctx: FunctionContext,
    expr: ts.CallExpression,
    elemAccess: ts.ElementAccessExpression,
  ): InnerResult | undefined {
    // 1. Resolve element type's call signatures (with NonNullable fallback)
    const elemTsType = ctx.checker.getTypeAtLocation(elemAccess);
    let callSigs = elemTsType.getCallSignatures?.();
    if (!callSigs || callSigs.length === 0) {
      const nn = ctx.checker.getNonNullableType(elemTsType);
      callSigs = nn.getCallSignatures?.();
    }
    if (!callSigs || callSigs.length === 0) return undefined;

    const sig = callSigs[0]!;
    const sigParamCount = sig.parameters.length;
    const sigRetType = ctx.checker.getReturnTypeOfSignature(sig);
    const sigRetWasm = isVoidType(sigRetType) ? null : resolveWasmType(ctx, sigRetType);
    const sigParamWasmTypes: ValType[] = [];
    for (let i = 0; i < sigParamCount; i++) {
      const paramType = ctx.checker.getTypeOfSymbol(sig.parameters[i]!);
      sigParamWasmTypes.push(resolveWasmType(ctx, paramType));
    }

    // 2. Eagerly create / find the wrapper struct (signature-keyed cache)
    const resultTypes = sigRetWasm ? [sigRetWasm] : [];
    const wrapperTypes = getOrCreateFuncRefWrapperTypes(ctx, sigParamWasmTypes, resultTypes);
    if (!wrapperTypes) return undefined;
    const { structTypeIdx: wrapperStructIdx, closureInfo } = wrapperTypes;

    // 3. Compile elemAccess to push the element value (will be externref
    //    for `Fn[]` since arrays of callables are stored as vec<externref>).
    const elemResult = compileExpression(ctx, fctx, elemAccess);
    if (!elemResult) return undefined;

    // 4. Coerce to closure-struct ref (mirror calls-closures.ts:507-519)
    const closureRefType: ValType = { kind: "ref_null", typeIdx: wrapperStructIdx };
    const closureLocal = allocLocal(fctx, `__cea_${fctx.locals.length}`, closureRefType);
    if (elemResult.kind === "externref") {
      fctx.body.push({ op: "any.convert_extern" });
      emitGuardedRefCast(fctx, wrapperStructIdx);
    } else if (elemResult.kind === "ref" || elemResult.kind === "ref_null") {
      // Already a struct ref — guard cast if shape differs
      if ((elemResult as { typeIdx: number }).typeIdx !== wrapperStructIdx) {
        emitGuardedRefCast(fctx, wrapperStructIdx);
      }
    } else {
      // Primitive element type with call signatures shouldn't happen
      return undefined;
    }
    fctx.body.push({ op: "local.set", index: closureLocal });

    // 5. Push self (closureRef) as first lifted-fn arg, null-check throw
    fctx.body.push({ op: "local.get", index: closureLocal });
    emitNullCheckThrow(ctx, fctx, closureRefType);

    // 6. Compile call args (clamped/padded — copy lines 462-478)
    const cpParamCount = closureInfo.paramTypes.length;
    for (let i = 0; i < Math.min(expr.arguments.length, cpParamCount); i++) {
      compileExpression(ctx, fctx, expr.arguments[i]!, closureInfo.paramTypes[i]);
    }
    for (let i = cpParamCount; i < expr.arguments.length; i++) {
      const t = compileExpression(ctx, fctx, expr.arguments[i]!);
      if (t !== null) fctx.body.push({ op: "drop" });
    }
    for (let i = expr.arguments.length; i < cpParamCount; i++) {
      pushDefaultValue(fctx, closureInfo.paramTypes[i]!, ctx);
    }

    // 7. Extract funcref + call_ref (mirror lines 543-557)
    fctx.body.push({ op: "local.get", index: closureLocal });
    emitNullCheckThrow(ctx, fctx, closureRefType);
    fctx.body.push({ op: "struct.get", typeIdx: wrapperStructIdx, fieldIdx: 0 });
    emitGuardedFuncRefCast(fctx, closureInfo.funcTypeIdx);
    emitNullCheckThrow(ctx, fctx, { kind: "ref_null", typeIdx: closureInfo.funcTypeIdx });
    fctx.body.push({ op: "call_ref", typeIdx: closureInfo.funcTypeIdx });

    return closureInfo.returnType ?? VOID_RESULT;
  }
  ```

  Imports already present in calls-closures.ts cover everything used here.

**File: `src/codegen/expressions/calls.ts`**

- Add `compileCallableElementAccessCall` to the imports at the top
  (~line 70 next to `compileCallablePropertyCall`).

- Inside the `ts.isElementAccessExpression(expr.expression)` block at
  line 5927, before the resolved-method-name fallback at line 6371-6386,
  call the new helper:

  ```ts
  // ELEM ACCESS RESOLVED, NO METHOD MATCHED — try callable element type
  // (e.g. `fns[0](args)` where `fns: ((s) => string)[]`)
  {
    const cea = compileCallableElementAccessCall(ctx, fctx, expr, elemAccess);
    if (cea !== undefined) return cea;
  }
  // Fallback (existing): compile receiver, drop, etc. → ref.null.extern
  ```

- Inside the **unresolved-index** fallback at line 6389-6409, call the
  helper FIRST before dropping:

  ```ts
  // ELEM ACCESS UNRESOLVED — try callable element type (#1306)
  // Covers `mws[idx](c, next)` where idx is a runtime variable.
  {
    const cea = compileCallableElementAccessCall(ctx, fctx, expr, elemAccess);
    if (cea !== undefined) return cea;
  }
  // Fallback (existing): compile receiver/index/args, drop, ref.null.extern
  ```

### Wasm IR pattern

For `mws[idx](c, next)` where `mws: Mw[]`, `Mw = (c, n) => string`:

```wasm
;; --- elemAccess: mws[idx] ---
local.get $mws_local            ;; vec struct ref
struct.get $vec_extern $data    ;; backing array<externref>
local.get $idx                  ;; i32 index (or i32 from f64 trunc)
array.get $arr_extern           ;; → externref (the boxed __fn_wrap)

;; --- coerce to closure struct ---
any.convert_extern              ;; externref → anyref
ref.test (ref $__fn_wrap_Mw)    ;; emitGuardedRefCast: skip cast on miss
ref.cast (ref $__fn_wrap_Mw)
local.tee $__cea_42             ;; saved closure ref

;; --- self + args ---
local.get $__cea_42
ref.is_null  if  throw TypeError  end
local.get $__cea_42             ;; self (lifted-fn first param)
local.get $c
local.get $next                 ;; closure-typed (should already be ref or externref-coerced)

;; --- funcref extract + call ---
local.get $__cea_42
struct.get $__fn_wrap_Mw $func  ;; funcref
ref.cast (ref $__fn_wrap_Mw_type)  ;; emitGuardedFuncRefCast
ref.is_null  if  throw TypeError  end
call_ref $__fn_wrap_Mw_type
;; Stack: [externref] (the "[A]end" string)
```

### Edge cases

- **Literal index**: `fns[0](args)` — `argExpr` is a `NumericLiteral`, so
  `resolvedMethodName = "0"` and we land in the resolved-no-method branch
  (fix call site #1).
- **Const-bound index**: `const I = 0; fns[I](args)` — `resolveComputedKeyExpression`
  returns `"0"`, same branch as literal.
- **Runtime index**: `fns[idx](args)` — `resolvedMethodName === undefined`,
  fix call site #2.
- **`Mw | undefined` element type** (sparse arrays / strict null) — the
  `getNonNullableType` fallback inside the helper handles this.
- **Empty array → out-of-bounds**: existing `emitBoundsCheckedArrayGet` in
  property-access.ts:2659 traps; the helper inherits this. Acceptance
  criteria require the in-bounds case to work.
- **Wrong-type element**: if a non-callable externref is somehow stored,
  `emitGuardedRefCast` returns null after the cast; `emitNullCheckThrow`
  then raises TypeError instead of trapping. Same semantics as
  `compileCallablePropertyCall`.
- **Element type is a registered closure struct ref (not externref)**:
  the `ref`/`ref_null` branch in step 4 handles structurally-typed arrays
  whose elements are `(ref $closure_struct)` directly. Less common but
  possible after closure-typed-array specialisations land.
- **Native `i32`/`f64` element arrays**: callSigs is empty, helper returns
  undefined, existing fallback runs (no behaviour change).
- **Tuple-typed receiver**: `(Mw, Mw, Mw)[i]` — element access on tuple
  goes through tuple-struct.get at property-access.ts:2546-2558. The
  helper's `compileExpression(ctx, fctx, elemAccess)` handles this
  correctly because compileElementAccess routes by struct kind.

### Test pattern: `tests/issue-1306.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { run } from "./helpers/run.js";

describe("#1306 — element-access call on callable array", () => {
  it("compose two middlewares running in registration order", async () => {
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
            return mws[idx](c, next);
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

  it("single middleware that calls next", async () => {
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
            return mws[idx](c, next);
          }
          return next();
        };
      }
      export function test(): string {
        return compose([(c, n: N) => "[A]" + n()])(0);
      }
    `);
    expect(exports.test!()).toBe("[A]end");
  });

  it("literal-index call on callable array (#1298 acceptance #2)", async () => {
    const { exports } = await run(`
      export function test(): string {
        const fns: ((s: string) => string)[] = [(s) => s + "!"];
        return fns[0]("hi");
      }
    `);
    expect(exports.test!()).toBe("hi!");
  });

  it("const-bound index call", async () => {
    const { exports } = await run(`
      export function test(): string {
        const fns: ((s: string) => string)[] = [(s) => s + "!", (s) => s + "?"];
        const i = 1;
        return fns[i]("hi");
      }
    `);
    expect(exports.test!()).toBe("hi?");
  });

  it("runtime-index dispatch picks the right element", async () => {
    const { exports } = await run(`
      export function test(): string {
        const fns: ((s: string) => string)[] = [(s) => s + "A", (s) => s + "B"];
        let acc = "";
        for (let i = 0; i < fns.length; i++) acc = acc + fns[i]("x");
        return acc;
      }
    `);
    expect(exports.test!()).toBe("xAxB");
  });
});
```

Plus un-skip Tier 5c "two middlewares run in registration order" at
`tests/stress/hono-tier5.test.ts:266` — strip the `it.skip` and the
`(#1301)` marker (the closure-env mismatch surface from #1301 is
distinct; per the issue body, Tier 5c is now blocked solely on this
bug after #1301 landed).

### Risks & ordering vs #1298

- This issue and #1298 both touch `src/codegen/expressions/calls.ts` and
  `src/codegen/expressions/calls-closures.ts`. The sections don't
  overlap:
  - #1298 → propAccess block @ ~925, NonNull unwrap @ ~914,
    generic fallback @ ~6680, `compileCallablePropertyCall` body @ ~430.
  - #1306 → ElementAccessExpression block @ ~5927-6410, new
    `compileCallableElementAccessCall` helper appended to calls-closures.ts.
- They can be **dispatched in parallel**. The dev on #1306 should add
  the new helper at the bottom of calls-closures.ts to minimise diff
  overlap with #1298's edits to `compileCallablePropertyCall`.
- Both rely on `getOrCreateFuncRefWrapperTypes` being signature-keyed
  (already cached via `funcRefWrapperCache`), so order-of-merge doesn't
  affect correctness — the wrapper struct identity is stable.
- After both land, run `npm test -- tests/stress/hono-tier5.test.ts`
  with the un-skipped tests to confirm end-to-end Hono dispatch works.
