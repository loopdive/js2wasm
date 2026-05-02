---
id: 1169e
title: "IR Phase 4 Slice 6 — iterators and for-of through the IR path"
status: done
created: 2026-04-27
updated: 2026-04-27
completed: 2026-04-27
priority: high
feasibility: hard
reasoning_effort: max
task_type: feature
area: codegen
language_feature: compiler-internals
goal: platform
depends_on: [1169d]
required_by: [1169f, 1169g, 1169h, 1181]
pr: 63
merged: 2026-04-27
---
# #1169e — IR Phase 4 Slice 6: iterators and for-of through IR

## Goal

Extend the IR selector (`src/ir/select.ts`) and IR lowering
(`src/ir/from-ast.ts`, `src/ir/lower.ts`) so functions that use **for-of
loops** stop falling through to legacy codegen. Slice 6 introduces the
first **statement-level loop** to the IR (until now `lowerStatementList`
only knew tail-shaped programs and an `if`-without-else early-return), so
it ships two things in one slice:

1. A **generic loop scaffold** — block / loop / br / br_if terminators
   wired up at the IR-tail level (used by for-of, slice 7's generator
   bodies, slice 8's destructuring with rest, and any future statement
   form that needs structured iteration).
2. The **for-of statement** itself, in three flavours that match the
   legacy strategy in `src/codegen/statements/loops.ts:1456`:
   - **Array fast path** — for-of over a known WasmGC vec struct
     (`Array<T>`, tuple types). Iterates `i = 0..length-1` reading
     `data[i]` directly. No host import.
   - **String fast path** — for-of over a `string`-typed expression.
     In native-strings mode iterates via `__str_charAt`; in host
     mode falls back to the iterator protocol.
   - **Iterator protocol fallback** — anything else (Map, Set, user
     iterables). Calls the host imports `__iterator`, `__iterator_next`,
     `__iterator_done`, `__iterator_value`, `__iterator_return` already
     registered by `addIteratorImports` (`src/codegen/index.ts:4238`).

This is Slice 6 from the #1169 migration roadmap ("Iterators + `for-of`
— iterator protocol, `Symbol.iterator`").

## Scope (what's in / out for this slice)

```
IR-claimable for-of                                   Legacy-only (rejected)
─────────────────────────────────────────────         ─────────────────────────────
for (const x of arr) { <body> }                       for await (const x of asyncIter) { ... }
  arr resolves to a known vec struct OR                 (defer to slice 7 — async-iter)
  IrType.string OR IrType.object with a known
  shape that has [Symbol.iterator] method (slice
  6.5 follow-up)                                      for (const x of customIterable) { ... }
                                                        customIterable not provably array,
                                                        string, or vec struct → falls back
for (const x of "hello") { <body> }                     to legacy until slice 6.5
  string-typed expression, native-strings mode          (host-iterator path needs externref
                                                         interop the IR doesn't yet do)
for (const x of new Set([1,2,3])) { ... }
  Set / Map / generator object iteration —             for (const [a, b] of pairs) { ... }
  uses host iterator protocol via IR-level              array destructuring binding —
  iter.* instructions that lower to __iterator*         depends on slice 8

let x; for (x of arr) { ... }                         for-of inside a try with break/return
  expression-form initializer, identifier                that escapes the loop —
  binding only                                          works (loop adds depths to break/
                                                         continue stacks the same way as
                                                         legacy)

continue / break inside the loop body                 labeled break / continue
  unlabeled forms only                                  (defer)
```

Body statements inside the for-of must themselves be Phase-1 acceptable
as **statements** — that's a larger surface than the current Phase-1
expression set. Slice 6 introduces the corresponding `isPhase1Stmt`
recognizer (separate from `isPhase1Tail`) covering:

- `ExpressionStatement` whose expression is a Phase-1 call or
  assignment (already partially in slice 3 for bare calls)
- `VariableStatement` (already in slice 1)
- `IfStatement` (with or without `else`) whose arms are statement
  blocks
- `BreakStatement` / `ContinueStatement` (no label)
- `ReturnStatement` (only in tail position for non-loop functions; in
  loop body it's a normal control-flow exit)
- Nested `ForOfStatement`
- `Block { ... }` recursing on its statements

## Key files

- `src/ir/select.ts` — `isPhase1StatementList`, `isPhase1Tail`, new
  `isPhase1Stmt`, `isPhase1Expr` (accept `for-of`-claimable iterables)
- `src/ir/nodes.ts` — `IrInstr` additions: `iter.new`, `iter.next`,
  `iter.done`, `iter.value`, `iter.return`; possibly new
  `IrTerminatorBr` already covers loop control (the existing branch
  primitives suffice — see step 4)
- `src/ir/from-ast.ts` — new `lowerForOfStatement`, statement-level
  `lowerStmt` dispatcher, `lowerBreakContinue`, helpers to emit the
  three for-of strategies; extension of `lowerStatementList` to call
  `lowerStmt` for non-tail statements
- `src/ir/lower.ts` — emit cases for the new iter.* instrs, falling
  through to the same Wasm sequences emitted by
  `compileForOfArray` / `compileForOfString` / `compileForOfIterator`
- `src/ir/integration.ts` — register the iterator host imports lazily
  via the resolver (delegate to `addIteratorImports`)
- `src/ir/builder.ts` — wrapper methods for the new instr kinds and a
  `loop` / `block` block-shape helper for the IR builder
- `src/ir/types.ts` — `IrType.iterator` if we need to model iterator
  values as first-class (probably not — iterators stay Wasm-local;
  see "Design choice" below)

## Implementation Plan

### Root cause / current state

Today the IR's tail-only model can't represent loops at all. Even a
trivially numeric kernel that contains `while (i < n) i++;` falls back
to legacy because `isPhase1StatementList` only accepts `var-decl;
var-decl; <tail>` shapes. `lowerTail` recognizes `return`, `block`,
and `if/else`, nothing else.

For-of additionally requires:
- An iteration protocol (counter loop OR host-iterator state)
- A fresh local for the loop variable on every iteration
- Break / continue dispatch (br with the right depth to escape the
  enclosing loop / block)
- A null guard on the iterable (legacy throws `TypeError` on
  `for (... of null)` — `loops.ts:1614, 2373`)
- For host iterators, an iterator-close `try/finally` that calls
  `iter.return()` if the loop exits abnormally (`loops.ts:2486-2497`)

The legacy path lives in `src/codegen/statements/loops.ts`:

- `compileForOfStatement` (line 1456) — dispatcher
- `compileForOfArray` (line 1662) — vec-struct counter loop
- `compileForOfArrayTentative` (line 1634) — the "compile expr first,
  see if it's a vec struct" probe
- `compileForOfString` (line 1483) — native-strings counter loop
- `compileForOfIterator` (line 2334) — host iterator protocol

The host iterator imports are registered by `addIteratorImports`
(`src/codegen/index.ts:4238`) as five funcs:
```
__iterator        : (externref) -> externref     ;; obj[Symbol.iterator]()
__iterator_next   : (externref) -> externref     ;; iter.next() -> {value, done}
__iterator_done   : (externref) -> i32           ;; result.done ? 1 : 0
__iterator_value  : (externref) -> externref     ;; result.value
__iterator_return : (externref) -> ()            ;; iter.return() if present
```

### Design choice — keep iterators Wasm-local, not first-class IrType

Iterator state never escapes a single for-of body in well-formed
programs, so we don't need an `IrType.iterator` arm. Instead, the new
`iter.*` instructions consume / produce **opaque externref or struct
handles** (matching the underlying Wasm representation) and the IR
builder synthesizes a per-loop temporary local. This mirrors the
legacy's use of `iterLocal = allocLocal(...)` instead of carrying
iterators through user-visible bindings.

If a future slice needs to pass iterators between functions (e.g. a
helper that takes an `Iterator<T>` parameter), we'd add `IrType.iterator
{ elem: IrType }` then. Slice 6 doesn't need it.

### New IR nodes needed

#### 1. Loop / block control terminators — REUSE the existing primitives

The IR already has `IrTerminatorBr` and `IrTerminatorBrIf` with `target`
+ `args`. To express a Wasm `block { loop { ... } }` shape we don't
need a new terminator kind — we just need:

- **A new block-arg shape on the entry block of the loop body.** The
  loop entry block has zero block-args (loop variables live in `let`
  bindings inside the body, materialised as Wasm locals by the
  builder). The "after-loop" block has zero block-args too (control
  resumes with whatever the loop produced via side effects).
- **Two reserved blocks per for-of**: `loopHeader` (the target of
  `continue`) and `loopExit` (the target of `break` / "iterator
  exhausted"). `lowerForOfStatement` reserves them up front, lowers
  the body statements while pushing them onto a new
  `cx.loopStack: { header: IrBlockId, exit: IrBlockId }[]`, then
  finalises the block layout.

The lowerer maps the IR block-graph to Wasm structured control flow
via the existing block-layout pass (no change). The `block` / `loop`
Wasm wrappers come from `lowerIrFunctionToWasm`'s structured-CFG
recovery, which already handles `br`/`br_if` to reserved blocks.

#### 2. New `IrInstr` variants — iterator protocol + statement-level ops

**File: `src/ir/nodes.ts`** — add to the `IrInstr` union (after the
slice-3 `refcell.*` block):

```ts
/**
 * Slice 6 (#1169e) — opaque iterator handle for the host iterator
 * protocol fallback. Produced by `iter.new`, consumed by `iter.next`
 * / `iter.return`. Result type is `irVal({ kind: "externref" })` so
 * the value can flow through the existing SSA machinery without a
 * new IrType arm.
 *
 * Lowering:
 *   <emit iterable>                    ;; pushes externref
 *   call $__iterator                    ;; -> externref (the iterator)
 */
export interface IrInstrIterNew extends IrInstrBase {
  readonly kind: "iter.new";
  readonly iterable: IrValueId;
  /** True if this is a `for await` loop — calls `__async_iterator` instead. */
  readonly async: boolean;
}

/**
 * Call iter.next() and return the result object handle (externref).
 * The result is later split into `done` / `value` via separate instrs
 * so the builder can decide whether to evaluate `value` (skip if done).
 *
 * Lowering: <emit iter>; call $__iterator_next  -> externref
 */
export interface IrInstrIterNext extends IrInstrBase {
  readonly kind: "iter.next";
  readonly iter: IrValueId;
}

/**
 * Test whether an iterator-result object's `.done` is true.
 * Result type: `irVal({ kind: "i32" })` (bool).
 *
 * Lowering: <emit result>; call $__iterator_done -> i32
 */
export interface IrInstrIterDone extends IrInstrBase {
  readonly kind: "iter.done";
  readonly result: IrValueId;
}

/**
 * Read the `.value` slot of an iterator-result object.
 * Result type: `irVal({ kind: "externref" })`.
 *
 * Lowering: <emit result>; call $__iterator_value -> externref
 */
export interface IrInstrIterValue extends IrInstrBase {
  readonly kind: "iter.value";
  readonly result: IrValueId;
}

/**
 * Call `iter.return()` if defined. Void result. Used by the iterator-close
 * try/finally so abrupt exits notify the iterator.
 *
 * Lowering: <emit iter>; call $__iterator_return
 */
export interface IrInstrIterReturn extends IrInstrBase {
  readonly kind: "iter.return";
  readonly iter: IrValueId;
}

/**
 * Index into a vec struct for the array fast path. `vec` must be an
 * IrType.val with kind `ref`/`ref_null` to a registered vec struct
 * (verified at lowering time via the resolver). `index` is i32.
 * Result type: the vec's element IrType (carried in `resultType`).
 *
 * Lowering:
 *   <emit vec>; struct.get $vec $data       ;; -> ref to elem array
 *   <emit index>; array.get $elemArr        ;; -> elem value
 */
export interface IrInstrVecGet extends IrInstrBase {
  readonly kind: "vec.get";
  readonly vec: IrValueId;
  readonly index: IrValueId;
}

/**
 * Read `vec.length` (i32) from a vec struct. Used by both the for-of
 * counter and length-bound semantics.
 *
 * Lowering: <emit vec>; struct.get $vec $length  -> i32
 */
export interface IrInstrVecLen extends IrInstrBase {
  readonly kind: "vec.len";
  readonly vec: IrValueId;
}
```

Also add `IrInstrIter*` variants to the `IrInstr` union, the
`collectIrUses` switch in `lower.ts:730-786`, and the verifier's
`collectUses` switch.

#### 3. Builder helpers — `src/ir/builder.ts`

```ts
emitIterNew(iterable: IrValueId, async: boolean): IrValueId {
  const result = this.allocator.fresh();
  const resultType: IrType = irVal({ kind: "externref" });
  this.valueTypes.set(result, resultType);
  this.requireBlock().instrs.push({
    kind: "iter.new", iterable, async, result, resultType,
  });
  return result;
}

emitIterNext(iter: IrValueId): IrValueId { /* parallel structure */ }
emitIterDone(result: IrValueId): IrValueId { /* returns i32 */ }
emitIterValue(result: IrValueId): IrValueId { /* returns externref */ }
emitIterReturn(iter: IrValueId): void { /* void */ }
emitVecLen(vec: IrValueId): IrValueId { /* returns i32 */ }
emitVecGet(vec: IrValueId, index: IrValueId, elemType: IrType): IrValueId { ... }
```

### Step 1 — `src/ir/nodes.ts`: add the seven new instr variants

Per "New IR nodes needed" above. Add to the `IrInstr` union and to the
verifier's `collectUses` (`verify.ts`):

```ts
case "iter.new":   return [instr.iterable];
case "iter.next":  return [instr.iter];
case "iter.done":  return [instr.result];
case "iter.value": return [instr.result];
case "iter.return":return [instr.iter];
case "vec.len":    return [instr.vec];
case "vec.get":    return [instr.vec, instr.index];
```

### Step 2 — `src/ir/builder.ts`: builder methods

Per "Builder helpers" above. Each method follows the slice-3
`emitClosureNew` pattern: allocate a fresh SSA id, set
`valueTypes`, push the instr to the current block.

### Step 3 — `src/ir/select.ts`: extend the selector

#### 3a. `isPhase1StatementList` — accept `ForOfStatement` in non-tail position

Currently `lowerStatementList` only sees var-decls, nested fns, bare
calls, and `if`-without-else before the tail. Add a `ForOfStatement`
case:

```ts
if (ts.isForOfStatement(s)) {
  if (!isPhase1ForOf(s, scope)) return false;
  continue;  // for-of is a statement, control resumes to next stmt
}
```

#### 3b. New `isPhase1ForOf` helper

```ts
function isPhase1ForOf(stmt: ts.ForOfStatement, scope: Set<string>): boolean {
  if (stmt.awaitModifier) return false;            // defer to slice 7

  // Initializer must be `const x` or `let x` or bare identifier — no
  // destructuring (slice 8 widens this).
  let loopVarName: string;
  if (ts.isVariableDeclarationList(stmt.initializer)) {
    if (stmt.initializer.declarations.length !== 1) return false;
    const d = stmt.initializer.declarations[0]!;
    if (!ts.isIdentifier(d.name)) return false;    // no destructuring
    if (d.initializer) return false;               // no default value
    loopVarName = d.name.text;
  } else if (ts.isIdentifier(stmt.initializer)) {
    loopVarName = stmt.initializer.text;
    if (!scope.has(loopVarName)) return false;     // must be pre-declared
  } else {
    return false;                                  // expression-form destructuring
  }

  // Iterable must be a Phase-1 expression. The array-vs-iterator
  // distinction is made at lowering time using the TS checker's
  // type info (slice 6 doesn't try to do it here).
  if (!isPhase1Expr(stmt.expression, scope)) return false;

  // Loop body: must be a Phase-1 statement list.
  const innerScope = new Set(scope);
  innerScope.add(loopVarName);
  return isPhase1Stmt(stmt.statement, innerScope, /* inLoop */ true);
}
```

#### 3c. New `isPhase1Stmt` — statement-list recogniser for loop bodies

```ts
function isPhase1Stmt(stmt: ts.Statement, scope: Set<string>, inLoop: boolean): boolean {
  if (ts.isBlock(stmt)) {
    for (const s of stmt.statements) {
      if (!isPhase1Stmt(s, scope, inLoop)) return false;
    }
    return true;
  }
  if (ts.isVariableStatement(stmt)) {
    return isPhase1VarDecl(stmt, scope);
  }
  if (ts.isExpressionStatement(stmt)) {
    // Bare call (slice 3) OR identifier assignment (new in slice 6 —
    // needed because `i++` and `x = x + 1` show up in loop bodies).
    if (ts.isCallExpression(stmt.expression)) {
      return isPhase1Expr(stmt.expression, scope);
    }
    if (ts.isBinaryExpression(stmt.expression)) {
      const op = stmt.expression.operatorToken.kind;
      if (op === ts.SyntaxKind.EqualsToken && ts.isIdentifier(stmt.expression.left)) {
        if (!scope.has(stmt.expression.left.text)) return false;
        return isPhase1Expr(stmt.expression.right, scope);
      }
    }
    if (ts.isPostfixUnaryExpression(stmt.expression) || ts.isPrefixUnaryExpression(stmt.expression)) {
      const op = (stmt.expression as any).operator;
      if (op === ts.SyntaxKind.PlusPlusToken || op === ts.SyntaxKind.MinusMinusToken) {
        if (ts.isIdentifier((stmt.expression as any).operand)) return true;
      }
    }
    return false;
  }
  if (ts.isIfStatement(stmt)) {
    if (!isPhase1Expr(stmt.expression, scope)) return false;
    if (!isPhase1Stmt(stmt.thenStatement, scope, inLoop)) return false;
    if (stmt.elseStatement && !isPhase1Stmt(stmt.elseStatement, scope, inLoop)) return false;
    return true;
  }
  if (ts.isForOfStatement(stmt)) {
    return isPhase1ForOf(stmt, scope);
  }
  if (inLoop && ts.isBreakStatement(stmt)) return !stmt.label;
  if (inLoop && ts.isContinueStatement(stmt)) return !stmt.label;
  if (ts.isReturnStatement(stmt)) {
    if (!stmt.expression) return false;            // implicit-undefined return — defer
    return isPhase1Expr(stmt.expression, scope);
  }
  return false;
}
```

#### 3d. Call-graph closure — no change

For-of bodies that call non-local identifiers (`String`, `parseInt`)
already hit `hasExternalCall` via the existing recursive
`buildLocalCallGraph` walker, and `addIteratorImports` is registered
by the integration loop at compile time, so no new external-call
exemption is needed.

### Step 4 — `src/ir/from-ast.ts`: lower for-of statements

#### 4a. `LowerCtx` extensions

Add a loop stack so `break` / `continue` know what blocks to br to,
and an iterator-close stack so a `return` inside a host-iterator for-of
calls `iter.return()` first:

```ts
interface LoopFrame {
  /** continue-target block id (loop header). */
  readonly headerBlock: IrBlockId;
  /** break-target block id (loop exit). */
  readonly exitBlock: IrBlockId;
  /** If this is a host-iterator loop, the iterator value to close
   *  before propagating a return. Null for array/string fast paths. */
  readonly iterToClose: IrValueId | null;
}

interface LowerCtx {
  // ... existing fields ...
  readonly loopStack: LoopFrame[];                 // ← new
}
```

Initialise `loopStack: []` in `lowerFunctionAstToIr` and propagate
through every recursive `LowerCtx` spread.

#### 4b. `lowerStatementList` — dispatch to a new `lowerStmt` for loop bodies

The existing `lowerStatementList` in `from-ast.ts:145-220` only
handles tail-shaped programs. For loop bodies (and any future
statement context that doesn't end in a return), we need
`lowerStatements` that handles non-terminating sequences:

```ts
function lowerStatements(stmts: readonly ts.Statement[], cx: LowerCtx): void {
  for (const s of stmts) lowerStmt(s, cx);
}

function lowerStmt(s: ts.Statement, cx: LowerCtx): void {
  if (ts.isBlock(s)) { lowerStatements(s.statements, { ...cx, scope: new Map(cx.scope) }); return; }
  if (ts.isVariableStatement(s)) { lowerVarDecl(s, cx); return; }
  if (ts.isExpressionStatement(s)) { lowerExprStatement(s, cx); return; }
  if (ts.isIfStatement(s)) { lowerIfStatement(s, cx); return; }
  if (ts.isForOfStatement(s)) { lowerForOfStatement(s, cx); return; }
  if (ts.isBreakStatement(s)) { lowerBreak(s, cx); return; }
  if (ts.isContinueStatement(s)) { lowerContinue(s, cx); return; }
  if (ts.isReturnStatement(s)) { lowerReturnInsideLoop(s, cx); return; }
  throw new Error(`ir/from-ast: unexpected stmt in loop body (got ${ts.SyntaxKind[s.kind]} in ${cx.funcName})`);
}
```

`lowerExprStatement` covers bare calls (existing), identifier
assignments (new — emit `local.set` via the existing
`scope.set(name, ...)` machinery on a mutated value), and
`++`/`--` (lowered to `binary` + `local.set`).

#### 4c. `lowerForOfStatement` — three strategies

```ts
function lowerForOfStatement(stmt: ts.ForOfStatement, cx: LowerCtx): void {
  // 1. Decide strategy from the TS checker type.
  const tsType = cx.checker.getTypeAtLocation(stmt.expression);  // ← needs cx.checker (new)
  const strategy = chooseForOfStrategy(tsType, cx);
  // strategy is one of: "vec" | "string-native" | "iter-host"

  // 2. Lower the iterable expression to the appropriate IR value.
  const iterableHint = strategy === "vec"
    ? cx.builder.typeFromVecStruct(tsType)        // resolve Array<T> → object IrType
    : strategy === "string-native"
    ? { kind: "string" } as IrType
    : irVal({ kind: "externref" });
  const iterableValue = lowerExpr(stmt.expression, cx, iterableHint);

  // 3. Allocate the loop variable in scope.
  const elemType = elemIrTypeForStrategy(strategy, tsType, cx);
  const loopVarName = getLoopVarName(stmt.initializer);

  // 4. Reserve header + exit blocks.
  const headerId = cx.builder.reserveBlockId();
  const exitId   = cx.builder.reserveBlockId();

  // 5. Strategy-specific prologue + body lowering.
  switch (strategy) {
    case "vec":           lowerForOfVec(iterableValue, elemType, headerId, exitId, loopVarName, stmt, cx); break;
    case "string-native": lowerForOfString(iterableValue, headerId, exitId, loopVarName, stmt, cx); break;
    case "iter-host":     lowerForOfIter(iterableValue, headerId, exitId, loopVarName, stmt, cx); break;
  }

  // 6. After the loop, control falls through to whatever follows in
  // the enclosing statement list.
  cx.builder.openReservedBlock(exitId);
}
```

#### 4d. `lowerForOfVec` — array fast path

Emits the same shape as `compileForOfArray` (`loops.ts:1662`):

```ts
function lowerForOfVec(
  vec: IrValueId, elemType: IrType,
  headerId: IrBlockId, exitId: IrBlockId, loopVarName: string,
  stmt: ts.ForOfStatement, cx: LowerCtx,
): void {
  // i = 0
  const iSlot = cx.builder.declareMutableLocal("__forof_i", irVal({ kind: "i32" }));
  cx.builder.emitConstAndStore(iSlot, { kind: "i32", value: 0 });
  // len = vec.length
  const lenV = cx.builder.emitVecLen(vec);
  const lenSlot = cx.builder.declareMutableLocal("__forof_len", irVal({ kind: "i32" }));
  cx.builder.emitStore(lenSlot, lenV);
  // br header
  cx.builder.terminate({ kind: "br", branch: { target: headerId, args: [] } });

  // header: if (i >= len) br exit; elem = vec[i]; <body>; i++; br header
  cx.builder.openReservedBlock(headerId);
  const i = cx.builder.emitLoad(iSlot);
  const len = cx.builder.emitLoad(lenSlot);
  const cond = cx.builder.emitBinary("i32.ge_s", i, len);            // cond = i >= len
  const bodyId = cx.builder.reserveBlockId();
  cx.builder.terminate({
    kind: "br_if",
    condition: cond,
    ifTrue:  { target: exitId, args: [] },
    ifFalse: { target: bodyId, args: [] },
  });

  cx.builder.openReservedBlock(bodyId);
  // elem = vec[i]
  const i2 = cx.builder.emitLoad(iSlot);
  const elemV = cx.builder.emitVecGet(vec, i2, elemType);
  // Bind loopVarName to elemV in the body scope.
  const bodyCx: LowerCtx = {
    ...cx,
    scope: new Map(cx.scope),
    loopStack: [...cx.loopStack, { headerBlock: headerId, exitBlock: exitId, iterToClose: null }],
  };
  bodyCx.scope.set(loopVarName, { kind: "local", value: elemV, type: elemType });

  // Lower body statements.
  lowerStmt(stmt.statement, bodyCx);

  // Continue: i = i + 1; br header
  const i3 = cx.builder.emitLoad(iSlot);
  const one = cx.builder.emitConst({ kind: "i32", value: 1 });
  const iNext = cx.builder.emitBinary("i32.add", i3, one);
  cx.builder.emitStore(iSlot, iNext);
  cx.builder.terminate({ kind: "br", branch: { target: headerId, args: [] } });
}
```

(`declareMutableLocal` / `emitLoad` / `emitStore` are new builder
methods — slice 6 introduces "mutable Wasm-local slots" as a
distinct concept from SSA values, since the loop counter must be
reassigned each iteration. SSA equivalence would be a phi node at
the header; we approximate it by writing to an i32 Wasm local. The
builder allocates a slot index; emit/load wrap `local.get`/`local.set`.)

#### 4e. `lowerForOfString` — native-strings counter loop

Mirrors `compileForOfString` (`loops.ts:1483`). The element type is
`IrType.string` (single-char string), and we use the
`__str_charAt` native helper via a new `string.charAt` IR instr or
by emitting a raw call with `builder.emitCall({ kind: "func", name:
"__str_charAt" }, [strV, iV], { kind: "string" })`. Slice 6
takes the latter — no new IR instr — to avoid bloating the IR with
backend-specific helpers.

In host-strings mode (no `__str_charAt`), fall through to the
iterator protocol. The selector doesn't try to distinguish modes; the
lowerer chooses based on `cx.resolver.nativeStrings()` (new optional
resolver method).

#### 4f. `lowerForOfIter` — host iterator protocol

Mirrors `compileForOfIterator` (`loops.ts:2334`) using the new IR
instrs:

```ts
function lowerForOfIter(
  iterable: IrValueId,
  headerId: IrBlockId, exitId: IrBlockId, loopVarName: string,
  stmt: ts.ForOfStatement, cx: LowerCtx,
): void {
  // Coerce to externref if not already (inserts the IR-level cast op
  // — `coerce` is already a primitive in the IR via emit raw or a
  // new `convert` instr; if the type is `IrType.object`, emit
  // `extern.convert_any`).
  const iterableExt = cx.builder.emitCoerceToExternref(iterable);

  // Null guard (#775): if iterableExt is null, throw TypeError.
  // Use the existing exception tag via the resolver (slice 9 will
  // surface this as a first-class IR throw; for slice 6 we emit a
  // raw.wasm block with `ref.is_null; if; throw $tag`).
  emitNullGuardThrow(iterableExt, cx);

  // iter = __iterator(iterableExt)
  const iter = cx.builder.emitIterNew(iterableExt, /* async */ false);

  // Emit a try/finally to close the iterator on abrupt exit. Slice 6
  // approximation: emit only the normal-exit `iter.return` call (no
  // try/finally yet — that comes in slice 9). Track in
  // loopStack[i].iterToClose so a `return` inside the body can
  // inline `iter.return(iter)` via the same hook the legacy
  // `finallyStack` uses.

  // br header
  cx.builder.terminate({ kind: "br", branch: { target: headerId, args: [] } });

  // header:
  //   result = iter.next(iter)
  //   if (iter.done(result)) br exit
  //   value = iter.value(result)
  //   <body, with loopVarName bound to value>
  //   br header
  cx.builder.openReservedBlock(headerId);
  const result = cx.builder.emitIterNext(iter);
  const done = cx.builder.emitIterDone(result);
  const bodyId = cx.builder.reserveBlockId();
  cx.builder.terminate({
    kind: "br_if",
    condition: done,
    ifTrue:  { target: exitId, args: [] },
    ifFalse: { target: bodyId, args: [] },
  });

  cx.builder.openReservedBlock(bodyId);
  const value = cx.builder.emitIterValue(result);
  // Coerce externref → loop var's declared type if known. Slice 6
  // keeps the loop var typed as externref unless an explicit
  // annotation says otherwise.
  const elemType = irVal({ kind: "externref" });

  const bodyCx: LowerCtx = {
    ...cx, scope: new Map(cx.scope),
    loopStack: [...cx.loopStack, { headerBlock: headerId, exitBlock: exitId, iterToClose: iter }],
  };
  bodyCx.scope.set(loopVarName, { kind: "local", value, type: elemType });
  lowerStmt(stmt.statement, bodyCx);
  cx.builder.terminate({ kind: "br", branch: { target: headerId, args: [] } });

  // exit: emit normal-path iter.return.
  cx.builder.openReservedBlock(exitId);
  cx.builder.emitIterReturn(iter);
}
```

#### 4g. `lowerBreak` / `lowerContinue` — branch to loopStack frames

```ts
function lowerBreak(_s: ts.BreakStatement, cx: LowerCtx): void {
  const frame = cx.loopStack[cx.loopStack.length - 1];
  if (!frame) throw new Error(`ir/from-ast: break outside loop in ${cx.funcName}`);
  // Inline iter.return for any host-iterator loops we're skipping.
  if (frame.iterToClose !== null) cx.builder.emitIterReturn(frame.iterToClose);
  cx.builder.terminate({ kind: "br", branch: { target: frame.exitBlock, args: [] } });
}

function lowerContinue(_s: ts.ContinueStatement, cx: LowerCtx): void {
  const frame = cx.loopStack[cx.loopStack.length - 1];
  if (!frame) throw new Error(`ir/from-ast: continue outside loop in ${cx.funcName}`);
  cx.builder.terminate({ kind: "br", branch: { target: frame.headerBlock, args: [] } });
}
```

`lowerReturnInsideLoop` walks the loop stack from inside-out and
inlines `iter.return` for every host-iterator frame before emitting
`{ kind: "return", values: [v] }`.

#### 4h. `chooseForOfStrategy` — read TS checker

```ts
function chooseForOfStrategy(t: ts.Type, cx: LowerCtx): "vec" | "string-native" | "iter-host" {
  // 1. Array<T> or tuple → vec. Mirrors the legacy `isArray` check
  //    (loops.ts:1467-1469).
  if (isArrayType(t) || isTupleType(t)) return "vec";

  // 2. String-typed AND native-strings mode → string-native.
  //    Legacy guard: `isStringType(exprTsType) && ctx.nativeStrings && ctx.anyStrTypeIdx >= 0`
  //    (loops.ts:1462). The IR resolver exposes `nativeStrings()` for slice 6.
  if (isStringType(t) && cx.resolver?.nativeStrings?.()) return "string-native";

  // 3. Anything else → host iterator protocol.
  return "iter-host";
}
```

`cx` needs a `checker?: ts.TypeChecker` (passed through
`lowerFunctionAstToIr` from `integration.ts`). The integration loop
already has access to the checker — it's used for `propagate.ts`. Wire
it through.

### Step 5 — `src/ir/lower.ts`: emit cases for the new instrs

Inside `lowerIrFunctionToWasm`'s big instr switch:

```ts
case "iter.new": {
  const fnName = instr.async ? "__async_iterator" : "__iterator";
  const fn = resolver.resolveFunc({ kind: "func", name: fnName });
  emitValue(instr.iterable, out);
  out.push({ op: "call", funcIdx: fn });
  return;
}
case "iter.next": {
  const fn = resolver.resolveFunc({ kind: "func", name: "__iterator_next" });
  emitValue(instr.iter, out);
  out.push({ op: "call", funcIdx: fn });
  return;
}
case "iter.done": {
  const fn = resolver.resolveFunc({ kind: "func", name: "__iterator_done" });
  emitValue(instr.result, out);
  out.push({ op: "call", funcIdx: fn });
  return;
}
case "iter.value": {
  const fn = resolver.resolveFunc({ kind: "func", name: "__iterator_value" });
  emitValue(instr.result, out);
  out.push({ op: "call", funcIdx: fn });
  return;
}
case "iter.return": {
  const fn = resolver.resolveFunc({ kind: "func", name: "__iterator_return" });
  emitValue(instr.iter, out);
  out.push({ op: "call", funcIdx: fn });
  return;
}
case "vec.len": {
  const vecT = typeOf(instr.vec);
  const vec = resolver.resolveVec?.(vecT);
  if (!vec) throw new Error(`ir/lower: cannot resolve vec for vec.len in ${func.name}`);
  emitValue(instr.vec, out);
  out.push({ op: "struct.get", typeIdx: vec.structTypeIdx, fieldIdx: vec.lengthFieldIdx });
  return;
}
case "vec.get": {
  const vecT = typeOf(instr.vec);
  const vec = resolver.resolveVec?.(vecT);
  if (!vec) throw new Error(`ir/lower: cannot resolve vec for vec.get in ${func.name}`);
  emitValue(instr.vec, out);
  out.push({ op: "struct.get", typeIdx: vec.structTypeIdx, fieldIdx: vec.dataFieldIdx });
  emitValue(instr.index, out);
  out.push({ op: "array.get", typeIdx: vec.elemArrayTypeIdx });
  return;
}
```

`resolver.resolveVec` is a new IrLowerResolver method that takes an
`IrType` (the vec's IrType — the resolver inspects it to find the
vec struct + element array type indices). The integration sink in
`integration.ts` implements it by deferring to the existing
`getArrTypeIdxFromVec` (`src/codegen/registry/types.ts`).

### Step 6 — `src/ir/integration.ts`: register iterator imports lazily

Before phase 3 (lower), if any IR function uses `iter.*`, call the
existing `addIteratorImports(ctx)` so the resolver can resolve
`__iterator` / `__iterator_next` / etc. Detection: walk `built[].fn`
once, look for any `iter.*` instr.

```ts
let needsIteratorImports = false;
let needsAsyncIteratorImports = false;
for (const b of built) {
  for (const block of b.fn.blocks) {
    for (const instr of block.instrs) {
      if (instr.kind === "iter.new" && instr.async) needsAsyncIteratorImports = true;
      if (instr.kind === "iter.new" || instr.kind === "iter.next" ||
          instr.kind === "iter.done" || instr.kind === "iter.value" ||
          instr.kind === "iter.return") {
        needsIteratorImports = true;
      }
    }
  }
}
if (needsIteratorImports) addIteratorImports(ctx);
if (needsAsyncIteratorImports) ensureAsyncIterator(ctx, /* fctx */ null);
```

Wire after the IR build phase, before `lowerIrFunctionToWasm` runs —
otherwise `resolver.resolveFunc({ kind: "func", name: "__iterator" })`
returns undefined and lowering throws.

### Wasm IR pattern

Vec fast-path equivalent of `compileForOfArray`:

```wasm
;; vec on stack from compiled iterable expression
local.set $vec
;; i = 0
i32.const 0
local.set $i
;; len = vec.length
local.get $vec
struct.get $vec_struct $length
local.set $len
block
  loop
    ;; if (i >= len) br 1   ;; exit loop
    local.get $i
    local.get $len
    i32.ge_s
    br_if 1
    ;; elem = vec.data[i]
    local.get $vec
    struct.get $vec_struct $data
    local.get $i
    array.get $elem_array
    local.set $elem
    ;; <body>
    ;; i = i + 1
    local.get $i
    i32.const 1
    i32.add
    local.set $i
    br 0
  end
end
```

Iterator-protocol equivalent of `compileForOfIterator`:

```wasm
;; iterableExt on stack
call $__iterator
local.set $iter
block
  loop
    local.get $iter
    call $__iterator_next
    local.tee $result
    call $__iterator_done
    br_if 1
    local.get $result
    call $__iterator_value
    local.set $elem
    ;; <body>
    br 0
  end
end
;; normal-exit close
local.get $iter
call $__iterator_return
```

### Edge cases

- **Empty iterable** — vec path: `len === 0`, `i >= len` true on first
  check, br exit. Iter path: first `__iterator_next` returns
  `{ done: true }`, br exit. Both correctly skip the body.
- **`for (const x of null)`** — iter path emits a `ref.is_null` guard
  before `__iterator` and throws `TypeError`. Vec path: the iterable
  expression's IR type is `(ref $vec)` non-null when the TS type is
  `Array<T>`, so null can't appear via the IR path; if the TS type
  is `Array<T> | null` we fall back to legacy via the selector
  (slice 6 doesn't accept nullable iterables).
- **`break` / `continue` from a `for-of` nested inside another
  `for-of`** — `cx.loopStack` LIFO discipline ensures
  `loopStack[loopStack.length-1]` is always the innermost enclosing
  loop. Multi-level break is deferred (would need labeled break).
- **`return` inside a host-iterator for-of** — `lowerReturnInsideLoop`
  walks `cx.loopStack` and inlines `iter.return` for every host-iter
  frame on the way out. This matches the legacy `finallyStack`
  iter-close inlining (`loops.ts:2486-2497`).
- **String iteration when `nativeStrings === false`** — falls through
  to host iterator path (each character delivered as a single-char
  string via the host's `[Symbol.iterator]`).
- **For-of body that calls a non-IR-claimed function** — the
  call-graph closure pass in `select.ts` already drops the outer
  function in this case, so the for-of never reaches the IR lowerer.
- **`continue` skipping the i++ in the vec path** — slice 6 puts the
  i++ at the END of the body, before `br header`. A `continue` brs
  directly to header WITHOUT running the i++, which would loop
  forever. Fix: emit i++ at the START of header instead, or wrap the
  body in a sub-block whose exit lands on the i++ block. Slice 6
  uses the second approach: header → bodyBlock → continueBlock →
  br header. `continue` brs to continueBlock, not header.

### Suggested staging within the slice

1. **Step A — Loop scaffold + numeric while** (smallest possible
   widening). Add `IrTerminatorBr` users to header/exit blocks.
   Accept `while (cond) <stmt-list>` as a Phase-1 statement. Verify
   on a pure numeric kernel like `while (i < n) { sum += i; i++; }`.
2. **Step B — Vec for-of**. Add `vec.len`, `vec.get`, the
   resolver's `resolveVec`. Lower `for (const x of arr)` where
   `arr: number[]` to the counter loop. Verify on
   `tests/equivalence/for-of-numbers.ts`.
3. **Step C — Iterator protocol path**. Add `iter.*` instrs and
   the lazy-import wiring in integration.ts. Lower for-of over
   `Map`, `Set` to the host-iterator loop.
4. **Step D — String fast path**. Add `lowerForOfString`. Verify on
   `for (const c of "hello")` in native-strings mode.
5. **Step E — Iter-close on return / break**. Inline
   `iter.return` for abrupt exits.

Each sub-step adds equivalence tests in `tests/equivalence/` and
must not regress test262.

### Test262 categories that should move from FAIL/CE to PASS

- `language/statements/for-of/**` — most of the array / Map / Set
  iteration tests once the fast paths land
- `language/statements/break/**`, `continue/**` — inside loops
- `built-ins/Array/prototype/forEach/**` — these often test for-of
  semantics indirectly via callbacks
- `built-ins/Set/prototype/values/**`, `Map/prototype/entries/**` —
  result-object iteration

Slice 6 expected delta: +200 to +400 PASS based on the current FAIL
distribution. Ship in three CI rounds (steps A+B, then C, then D+E)
to keep regressions diagnosable.

## Acceptance criteria

1. `planIrCompilation` claims at least one function in
   `tests/equivalence/` whose body contains a `for (const x of arr)`
   over a typed array (verified by inspecting the selection output).
2. New equivalence tests covering:
   - `for (const x of arr)` over `number[]` and `string[]`
   - `for (const c of "hello")` in native-strings mode
   - `for (const k of new Set([1, 2, 3]))` (host iterator path)
   - `break` / `continue` inside a for-of body
   - `return` inside a host-iterator for-of (verifies iter.return)
3. Equivalence tests pass with no regressions.
4. Test262 net delta non-negative; `language/statements/for-of/**`
   pass count strictly increases.
5. `src/ir/select.ts` documents what for-of shapes are accepted in
   slice 6 (header comment over `isPhase1ForOf`).
6. The two iterator-import resolution paths (existing legacy
   `addIteratorImports` and the new resolver hook) produce
   identical Wasm bytes for a representative for-of kernel —
   verify with a one-shot bytewise diff.

## Implementation Status (2026-04-27 — foundation PR)

This PR ships the **slice-6 IR infrastructure** but stops short of
wiring up the AST → IR bridge for for-of statements. Acceptance
criteria 1, 2, 4, and 6 are deferred to a follow-up PR.

### What landed

- `IrInstr` additions in `src/ir/nodes.ts`: `slot.read`, `slot.write`,
  `vec.len`, `vec.get`, `forof.vec`. The `iter.*` family from the spec
  is intentionally deferred — slice 6 ships only the **vec fast path**
  scaffolding (steps A + B of the staged plan).
- `IrSlotDef` declarations on `IrFunction` for cross-iteration mutable
  state (Wasm-local slots placed AFTER SSA-driven locals).
- `IrFunctionBuilder` helpers in `src/ir/builder.ts`:
  `declareSlot`, `emitSlotRead`, `emitSlotWrite`, `emitVecLen`,
  `emitVecGet`, `emitForOfVec`, plus a `collectBodyInstrs(emit)`
  routing helper so loop-body emissions land in
  `IrInstrForOfVec.body` instead of the surrounding block.
- `ScopeBinding` extended in `src/ir/from-ast.ts` with a `slot` arm
  (slot-bound identifiers). The bridge code that USES this binding
  is the deferred work — see "What's left" below.
- `IrLowerResolver.resolveVec` interface in `src/ir/lower.ts` so the
  vec fast path can resolve a `(ref $vec_*)` ValType into the
  underlying struct + array typeIdx + element ValType.
- Lowering cases for the new instrs in `src/ir/lower.ts`:
  - `slot.read` / `slot.write` → `local.get` / `local.set` against
    the slot-base offset.
  - `vec.len` → `struct.get $vec $length` + `f64.convert_i32_s`
    (matches JS Number semantics).
  - `vec.get` → `struct.get $vec $data; <index>; array.get $arr`.
  - `forof.vec` → `block { loop { … } }` matching the Wasm IR
    pattern in the spec, with body instrs spliced into the loop
    body and slot-based counter / length / vec / data / element
    state.
- Cross-block use tracking in `lowerIrFunctionToWasm` extended to
  walk into `forof.vec` body buffers via `collectForOfBodyUses`,
  with body-internal uses recorded under a synthetic block id (-1)
  so any outer-defined SSA value referenced inside a loop body is
  always materialised to a Wasm local before the loop starts.
- `verify.ts`, `passes/dead-code.ts`, `passes/inline-small.ts`, and
  `passes/monomorphize.ts` all updated with the new instr cases
  (operand walks, side-effect classification, rename rewriting).
  `forof.vec` and `slot.write` are flagged side-effecting in DCE so
  loop bodies stay live; `forof.vec` operand collection recurses
  into the body buffer in DCE / monomorphize / verify.

### What's left (follow-up PR)

The infrastructure above is **inert** until the following bridges
land. None of the new instrs are emitted yet, so the lowered Wasm
bytes for any function are unchanged from main:

1. **Selector — re-enable for-of acceptance.** The `isPhase1ForOf` /
   `isPhase1BodyStatement` helpers were drafted in an earlier
   iteration but reverted in this PR (see the "Slice 6 (#1169e) —
   for-of statement acceptance is gated OFF" comment in
   `src/ir/select.ts`). Re-enable once the lowering bridge below
   exists.
2. **AST → IR lowering** in `src/ir/from-ast.ts`:
   - `lowerForOfStatement` (vec strategy: slot allocation,
     `collectBodyInstrs` body emission, `emitForOfVec` tying it
     together).
   - Dispatch in `lowerStatementList` for `ts.isForOfStatement(s)`.
   - Identifier-read path: when `ScopeBinding.kind === "slot"`,
     emit `slot.read` instead of returning the raw SSA value.
   - Identifier-assignment path: when the LHS resolves to a `slot`
     binding, emit `slot.write` (including the `total = total + x`
     accumulator pattern).
3. **Resolver — `resolveVec`** in `src/ir/integration.ts`.
   Implementation sketch: walk `ctx.mod.types[typeIdx]` for the
   given `(ref $vec_*)` ValType, verify the struct shape matches
   `{ length: i32, data: (ref $arr_*) }`, return
   `{ vecStructTypeIdx, lengthFieldIdx: 0, dataFieldIdx: 1, arrayTypeIdx, elementValType }`.
4. **Param/return type recognition for `Array<T>`** in
   `src/codegen/index.ts:resolvePositionType`. The legacy resolver
   already maps `number[]` / `Array<number>` to `(ref_null $vec_f64)`
   via `getOrRegisterVecType` (see `src/codegen/index.ts:4699`); the
   IR resolver needs the parallel arm so `function f(arr: number[])`
   carries an IR `irVal({ kind: "ref_null", typeIdx: vecIdx })`
   parameter type.
5. **Supporting features for non-trivial loop bodies.** The smallest
   useful for-of test (`let sum = 0; for (const x of arr) sum += x;`)
   needs three additional widenings the IR currently lacks:
   - `let` declarations in non-tail position with cross-loop mutation
     (currently the IR only supports `let`/`const` as initialisers
     for the tail-shaped statement list).
   - Compound assignment (`sum += x`).
   - Plain `<id> = <expr>` assignment in non-tail position. The
     selector-side helper `isPhase1BodyStatement` (drafted but
     reverted) handles this for in-loop use; the lowerer-side
     emitter doesn't exist yet.
6. **Iterator protocol** (`iter.new` / `iter.next` / `iter.done` /
   `iter.value` / `iter.return`) — slice 6 step C, deferred here.
7. **String fast path** (`__str_charAt` counter loop) — slice 6
   step D, deferred here.
8. **Iterator-close on abrupt exit** — slice 6 step E, deferred.

### Why ship as a foundation PR

The original 752-line landing put the IR infrastructure (nodes,
builder, lowerer, passes) in place but the selector accepted shapes
the lowerer couldn't lower, leaking IR-fallback errors into
previously-clean slice-3 tests
(`tests/issue-1169c.test.ts > "mutable capture closure-write"`).
This PR backs out the selector change so the regression heals while
preserving the infrastructure for an immediate follow-up. Net Wasm
delta vs. main: zero (no IR-claimable function emits a new instr).

The realisation in the field was that "for-of through IR" requires a
larger surface than slice 6 originally spec'd: the iterable
expression has to be IR-claimable (`Array<T>` recognition),
identifier mutation has to be IR-lowerable in non-tail position
(let / `<id> = <expr>` / `+=`), and the for-of body itself has to
compose against all of the above. Each of those is a slice-sized
change. The foundation is the right boundary for one PR.

## Sub-issue of

\#1169 — IR Phase 4: full compiler migration
