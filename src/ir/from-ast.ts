// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// AST → IR lowering.
//
// Phase 1 numeric/bool subset. The selector in `select.ts` restricts us to
// functions whose params are number/boolean, whose return type is
// number/boolean, and whose body is a "tail":
//   - zero or more `(let|const) <id> = <expr>;` declarations, followed by
//   - either `return <expr>;` OR `if (<expr>) <tail> else <tail>`,
//   - where each if-arm is itself a valid tail (terminates via return).
//
// `<expr>` may be:
//   - NumericLiteral / TrueKeyword / FalseKeyword
//   - Identifier referring to a parameter or a previously-declared local
//   - BinaryExpression with an arithmetic / comparison / logical operator
//   - PrefixUnaryExpression with `-`, `+`, `!`
//   - ConditionalExpression (`a ? b : c`)
//   - CallExpression to a locally-declared function (Phase 2)
//   - ParenthesizedExpression (unwrap)
//
// Everything else throws — the selector must keep those functions on the
// legacy path.
//
// Control flow is represented as basic blocks with `br_if` terminators. The
// entry block holds the pre-branch `let`/`const` decls; each if-arm is its
// own block (fork scope so declarations don't leak). Arms always terminate
// with `return` — Phase 1 doesn't model join blocks yet.
//
// Phase 2 extensions:
//   - Explicit TS `: number` / `: boolean` annotations are optional. When
//     absent, the caller passes `paramTypeOverrides` / `returnTypeOverride`
//     from the propagated TypeMap. This is what lets a recursive `fib`
//     whose `n` is untyped in source compile as `(f64) -> f64`.
//   - CallExpression to a local function lowers to `IrInstrCall`. The
//     call's return type comes from `callReturnTypes` (same TypeMap),
//     with arg types validated against the propagated callee param types.

import ts from "typescript";

import { evaluateConstantCondition } from "../codegen/statements/control-flow.js";
import { IrFunctionBuilder } from "./builder.js";
import type { IrLowerResolver, IrVecLowering } from "./lower.js";
import {
  asVal,
  closureSignatureEquals,
  irTypeEquals,
  irVal,
  type IrBinop,
  type IrClassShape,
  type IrClosureSignature,
  type IrFunction,
  type IrObjectShape,
  type IrType,
  type IrUnop,
  type IrValueId,
} from "./nodes.js";
import type { ValType } from "./types.js";

/**
 * Slice 10 (#1169i) — the from-ast view of one extern-class entry. Mirrors
 * `ExternClassInfo` from `src/codegen/context/types.ts` but limits the
 * surface to what the from-ast layer needs to validate `new ExternClass(...)`,
 * `recv.method(...)`, and property access on extern-class receivers.
 *
 * Methods carry the LEGACY-registered signature shape: `params[0]` is the
 * receiver `externref` and `params[1..]` are the user args. The from-ast
 * lowerer slices off the receiver when matching call args against
 * `params.slice(1)`. Slicing here keeps the from-ast logic dispatch-free.
 */
export interface IrExternClassMeta {
  readonly className: string;
  readonly constructorParams: readonly ValType[];
  readonly methods: ReadonlyMap<string, { readonly params: readonly ValType[]; readonly results: readonly ValType[] }>;
  readonly properties: ReadonlyMap<string, { readonly type: ValType; readonly readonly: boolean }>;
}

/**
 * Slice 6 part 4 refactor (#1185): a narrowed view of `IrLowerResolver`
 * restricted to the methods the AST→IR build phase actually consults.
 * Threading this subset through `LowerCtx` retires per-feature shortcuts
 * (`nativeStrings: boolean`, `anyStrTypeIdx: number`,
 * `inferVecElementValTypeFromContext`, etc.) without forcing the full
 * resolver — including its lazy struct registries that don't exist
 * yet at Phase-1 build time — into the from-ast layer.
 *
 * Phase-1 callable methods only:
 *   - `nativeStrings()` — backend mode discriminator
 *   - `resolveString()` — `IrType.string` ValType (extern vs native struct ref)
 *   - `resolveVec(valType)` — vec struct shape recovery
 *
 * Slice 10 (#1169i) adds:
 *   - `getExternClassInfo(name)` — extern-class metadata for slice-10
 *     lowering of `new ExternClass(...)`, `recv.method(...)`, and
 *     property access on extern-class receivers. Returns undefined if
 *     `name` isn't a registered extern class.
 *
 * The full `IrLowerResolver` (in `src/ir/lower.ts`) extends this and
 * adds Phase-3 methods like `resolveObject`, `resolveClass`,
 * `resolveClosure`. Those depend on registries that aren't populated
 * until Phase 3, so from-ast doesn't see them.
 */
export interface IrFromAstResolver {
  nativeStrings?(): boolean;
  resolveString?(): ValType;
  resolveVec?(valType: ValType): IrVecLowering | null;
  /**
   * Slice 10 (#1169i) — return metadata for the named extern class, or
   * `undefined` if no such class is registered.
   */
  getExternClassInfo?(className: string): IrExternClassMeta | undefined;
}

export interface AstToIrOptions {
  readonly exported?: boolean;
  /**
   * If present, overrides the IR types for the function's own parameters.
   * Indexed by parameter position. Used when the AST lacks explicit TS
   * type annotations and the Phase-2 propagation pass has inferred types.
   */
  readonly paramTypeOverrides?: readonly IrType[];
  /**
   * If present, overrides the IR return type. Same rationale as
   * `paramTypeOverrides`.
   */
  readonly returnTypeOverride?: IrType;
  /**
   * Map from callee function name to that callee's IR types (param +
   * return). Consulted when lowering a CallExpression whose callee is a
   * local function. Missing entries cause the lowerer to throw — the
   * selector's call-graph closure should guarantee every call we reach
   * has an entry.
   */
  readonly calleeTypes?: ReadonlyMap<string, { params: readonly IrType[]; returnType: IrType }>;
  /**
   * Slice 4 (#1169d): map from class name to that class's IR shape
   * (fields + methods + constructor signature). Consulted when lowering
   * NewExpression / class-receiver PropertyAccess / class-receiver
   * method calls. Missing entries cause the relevant lowering case to
   * throw, falling back to legacy.
   */
  readonly classShapes?: ReadonlyMap<string, IrClassShape>;
  /**
   * Slice 6 part 4 refactor (#1185): the from-ast view of the IR
   * lowerer's resolver. Replaces the per-feature shortcuts that
   * #1181 / #1182 / #1183 each added (`nativeStrings`,
   * `anyStrTypeIdx`, `inferVecElementValTypeFromContext`).
   *
   * Optional so existing tests / callers that don't need string or
   * vec type resolution can keep working. The `lowerForOfStatement`
   * arms that DO need it (string + vec) throw a clean fall-back-to-
   * legacy error when the resolver is absent or returns `null`.
   *
   * The integration layer (`compileIrPathFunctions`) is the canonical
   * supplier — it builds the resolver (or its subset) eagerly and
   * passes it in.
   */
  readonly resolver?: IrFromAstResolver;
}

/**
 * Slice 3 (#1169c): lowering an outer function may produce additional
 * lifted IR functions (one per nested function declaration / closure
 * expression). The integration layer treats these as synthesized
 * BuiltFns that get fresh funcIdx slots.
 */
export interface LoweredFunctionResult {
  readonly main: IrFunction;
  readonly lifted: readonly IrFunction[];
}

export function lowerFunctionAstToIr(fn: ts.FunctionDeclaration, options: AstToIrOptions = {}): LoweredFunctionResult {
  if (!fn.name) {
    throw new Error("ir/from-ast: function declaration without a name");
  }
  if (!fn.body) {
    throw new Error(`ir/from-ast: function ${fn.name.text} has no body`);
  }

  const name = fn.name.text;

  // Slice 7a (#1169f): `function*` produces a Generator-like externref
  // regardless of the source-level return type annotation
  // (`Generator<number>`, `IterableIterator<T>`, etc.). The IR result
  // type is unconditionally `externref`; the source annotation is
  // ignored at the IR layer.
  const isGenerator = !!fn.asteriskToken;
  const returnType: IrType = isGenerator
    ? irVal({ kind: "externref" })
    : resolveIrType(fn.type, options.returnTypeOverride, `return type of ${name}`);
  const params: { name: string; type: IrType }[] = fn.parameters.map((p, idx) => {
    if (!ts.isIdentifier(p.name)) {
      throw new Error(`ir/from-ast: destructuring params not supported in Phase 1 (${name})`);
    }
    const override = options.paramTypeOverrides?.[idx];
    return {
      name: p.name.text,
      type: resolveIrType(p.type, override, `param ${p.name.text} of ${name}`),
    };
  });

  const builder = new IrFunctionBuilder(name, [returnType], options.exported ?? false);

  // Single scope map for both params and let/const locals. Phase 1 forbids
  // shadowing (enforced by the selector) so there is no nesting to track.
  const scope = new Map<string, ScopeBinding>();
  for (const p of params) {
    const v = builder.addParam(p.name, p.type);
    scope.set(p.name, { kind: "local", value: v, type: p.type });
  }

  builder.openBlock();

  // Slice 7a (#1169f): generator prologue — allocate the `__gen_buffer`
  // Wasm-local slot, initialize it via `__gen_create_buffer()`. Must
  // happen AFTER `openBlock()` (instrs require a current block) and
  // BEFORE user-body lowering so `lowerYield` can emit `gen.push`
  // against the slot. The lowerer reads `func.generatorBufferSlot` to
  // produce the `local.get $__gen_buffer` op.
  let generatorBufferSlot: number | undefined;
  if (isGenerator) {
    builder.setFuncKind("generator");
    generatorBufferSlot = builder.declareSlot("__gen_buffer", { kind: "externref" });
    builder.setGeneratorBufferSlot(generatorBufferSlot);
    const buf = builder.emitCall({ kind: "func", name: "__gen_create_buffer" }, [], irVal({ kind: "externref" }));
    if (buf === null) {
      throw new Error(`ir/from-ast: __gen_create_buffer call must produce a value (${name})`);
    }
    builder.emitSlotWrite(generatorBufferSlot, buf);
  }

  const stmts = fn.body.statements;
  if (stmts.length < 1) {
    throw new Error(`ir/from-ast: Phase 1 expects at least 1 statement in ${name}`);
  }

  const lifted: IrFunction[] = [];
  const liftedCounter = { value: 0 };
  const mutatedLets = collectMutatedLetNames(fn);
  const cx: LowerCtx = {
    builder,
    scope,
    funcName: name,
    returnType,
    calleeTypes: options.calleeTypes,
    classShapes: options.classShapes,
    resolver: options.resolver,
    lifted,
    liftedCounter,
    mutatedLets,
    funcKind: isGenerator ? "generator" : "regular",
    generatorBufferSlot,
  };
  lowerStatementList(stmts, cx);

  return { main: builder.finish(), lifted };
}

function lowerStatementList(stmts: readonly ts.Statement[], cx: LowerCtx): void {
  if (stmts.length < 1) {
    throw new Error(`ir/from-ast: empty statement list in ${cx.funcName}`);
  }
  for (let i = 0; i < stmts.length - 1; i++) {
    const s = stmts[i]!;
    if (ts.isVariableStatement(s)) {
      lowerVarDecl(s, cx);
      continue;
    }
    // Slice 3 (#1169c): nested function declaration. Adds a
    // `nestedFunc` scope binding and lifts the body to a top-level IR
    // function in `cx.lifted`.
    if (ts.isFunctionDeclaration(s)) {
      lowerNestedFunctionDeclaration(s, cx);
      continue;
    }
    // Slice 3 (#1169c): bare call expression statement — lower the
    // call, drop the result. Lets `inc(); inc(); inc();` work.
    //
    // Slice 4 (#1169d): also accept `<obj>.<field> = <expr>;` — lowered
    // as `class.set` or `object.set` based on the receiver's IrType.
    if (ts.isExpressionStatement(s)) {
      if (ts.isCallExpression(s.expression)) {
        // The result SSA value is unused; DCE strips it if pure.
        // closure.call and call are flagged side-effecting in dead-code
        // so they stay live.
        void lowerExpr(s.expression, cx, irVal({ kind: "f64" }));
        continue;
      }
      // Slice 7a (#1169f): `yield <expr>;` as a top-level statement.
      // Selected only inside `function*` (the selector enforces this
      // at the function-claim level; if a non-generator function
      // somehow surfaces a yield here, `lowerYield` throws).
      if (ts.isYieldExpression(s.expression)) {
        lowerYield(s.expression, cx);
        continue;
      }
      if (
        ts.isBinaryExpression(s.expression) &&
        s.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(s.expression.left)
      ) {
        lowerPropertyAssignment(s.expression, cx);
        continue;
      }
      throw new Error(`ir/from-ast: unsupported ExpressionStatement shape in ${cx.funcName}`);
    }
    // Slice 6 part 2 (#1181): for-of statement (always non-tail). The
    // body is shape-checked by `isPhase1ForOf` and lowered via a
    // separate `lowerStmt` body-statement dispatcher (no nested
    // closures, no nested function decls).
    if (ts.isForOfStatement(s)) {
      lowerForOfStatement(s, cx);
      continue;
    }
    // Phase 2: early-return `if` with no else + subsequent statements.
    // Structurally: `if (cond) <tail>; <rest>` ≡ `if (cond) <tail> else { <rest> }`.
    // The then-arm lowers to its own block that terminates in `return`
    // (lowerTail enforces that); the else-arm opens a reserved block and
    // recursively lowers the remaining statements.
    if (ts.isIfStatement(s) && !s.elseStatement) {
      // #1043: compile-time constant fold. After --define substitution of
      // process.env.NODE_ENV (etc.), the condition may be a literal-vs-literal
      // comparison. Skip the dead arm so dev-only code never reaches codegen.
      const constResult = evaluateConstantCondition(s.expression);
      if (constResult !== undefined) {
        if (constResult) {
          // Then-arm taken: it must be a tail (returns), so the rest is
          // unreachable and we stop here.
          lowerTail(s.thenStatement, { ...cx, scope: new Map(cx.scope) });
          return;
        }
        // Then-arm dead: skip it and continue with the remaining statements
        // in the same block / scope.
        continue;
      }
      const cond = lowerExpr(s.expression, cx, irVal({ kind: "i32" }));
      const condType = cx.builder.typeOf(cond);
      if (asVal(condType)?.kind !== "i32") {
        throw new Error(`ir/from-ast: if condition must be bool in ${cx.funcName}`);
      }
      const thenId = cx.builder.reserveBlockId();
      const elseId = cx.builder.reserveBlockId();
      cx.builder.terminate({
        kind: "br_if",
        condition: cond,
        ifTrue: { target: thenId, args: [] },
        ifFalse: { target: elseId, args: [] },
      });

      cx.builder.openReservedBlock(thenId);
      lowerTail(s.thenStatement, { ...cx, scope: new Map(cx.scope) });

      cx.builder.openReservedBlock(elseId);
      const rest = stmts.slice(i + 1);
      lowerStatementList(rest, { ...cx, scope: new Map(cx.scope) });
      return;
    }
    throw new Error(`ir/from-ast: unexpected statement before tail (got ${ts.SyntaxKind[s.kind]} in ${cx.funcName})`);
  }
  lowerTail(stmts[stmts.length - 1]!, cx);
}

/**
 * Lower a "tail" statement — one that must end in a return on every path.
 * Phase 1 tails are: `return <expr>;`, a `Block { ... }` whose own tail is a
 * tail, or `if (<cond>) <tail> else <tail>`.
 */
function lowerTail(stmt: ts.Statement, cx: LowerCtx): void {
  if (ts.isReturnStatement(stmt)) {
    // Slice 7a/7b (#1169f): generator return. Match the legacy semantics
    // (`compileReturnStatement` in `codegen/statements/control-flow.ts`
    // line 89-123): a `return <value>` inside a `function*` pushes
    // `<value>` onto the eager buffer as a final yielded value, then
    // wraps the buffer with `__create_generator` to produce the
    // externref Generator object. This is non-spec — JS spec says the
    // return value lands in `IteratorResult.value` with `done:true` —
    // but matching legacy is the correctness target so existing
    // test262 coverage doesn't drift.
    //
    // Slice 7b widens the return type: we accept any Phase-1 expression
    // and route it through the same `lowerYield`-style dispatch
    // (f64/i32 stay native; ref/string/object/class coerce to
    // externref → __gen_push_ref). Same dispatch logic as `lowerYield`
    // except we get a `ts.Expression` already, not a YieldExpression.
    if (cx.funcKind === "generator") {
      if (stmt.expression) {
        const v = lowerExpr(stmt.expression, cx, irVal({ kind: "externref" }));
        const vt = cx.builder.typeOf(v);
        const valTy = asVal(vt);
        if (valTy?.kind === "f64" || valTy?.kind === "i32") {
          cx.builder.emitGenPush(v);
        } else {
          // Reference-shaped — coerce to externref upstream so the
          // lowerer's `__gen_push_ref` arm sees the right Wasm type.
          const vExt = coerceYieldValueToExternref(v, cx);
          cx.builder.emitGenPush(vExt);
        }
      }
      const generatorObj = cx.builder.emitGenEpilogue();
      cx.builder.terminate({ kind: "return", values: [generatorObj] });
      return;
    }
    if (!stmt.expression) {
      throw new Error(`ir/from-ast: Phase 1 return must have an expression in ${cx.funcName}`);
    }
    const v = lowerExpr(stmt.expression, cx, cx.returnType);
    cx.builder.terminate({ kind: "return", values: [v] });
    return;
  }
  if (ts.isBlock(stmt)) {
    // Fork scope — declarations inside the block stay local to this arm.
    const childCx: LowerCtx = { ...cx, scope: new Map(cx.scope) };
    lowerStatementList(stmt.statements, childCx);
    return;
  }
  if (ts.isIfStatement(stmt)) {
    if (!stmt.elseStatement) {
      throw new Error(`ir/from-ast: Phase 1 if must have an else arm in ${cx.funcName}`);
    }
    // #1043: compile-time constant fold. After --define substitution of
    // process.env.NODE_ENV (etc.), the condition may be a literal-vs-literal
    // comparison. Lower only the live arm so dev-only code never reaches codegen.
    const constResult = evaluateConstantCondition(stmt.expression);
    if (constResult !== undefined) {
      const taken = constResult ? stmt.thenStatement : stmt.elseStatement;
      lowerTail(taken, { ...cx, scope: new Map(cx.scope) });
      return;
    }
    const cond = lowerExpr(stmt.expression, cx, irVal({ kind: "i32" }));
    const condType = cx.builder.typeOf(cond);
    if (asVal(condType)?.kind !== "i32") {
      throw new Error(`ir/from-ast: if condition must be bool in ${cx.funcName}`);
    }
    // Reserve block IDs for both arms BEFORE terminating the current block.
    // The else ID must be fixed when we emit br_if, even though it opens after
    // any nested blocks the then-arm allocates.
    const thenId = cx.builder.reserveBlockId();
    const elseId = cx.builder.reserveBlockId();
    cx.builder.terminate({
      kind: "br_if",
      condition: cond,
      ifTrue: { target: thenId, args: [] },
      ifFalse: { target: elseId, args: [] },
    });

    cx.builder.openReservedBlock(thenId);
    lowerTail(stmt.thenStatement, { ...cx, scope: new Map(cx.scope) });

    cx.builder.openReservedBlock(elseId);
    lowerTail(stmt.elseStatement, { ...cx, scope: new Map(cx.scope) });
    return;
  }
  throw new Error(`ir/from-ast: unsupported tail statement ${ts.SyntaxKind[stmt.kind]} in ${cx.funcName}`);
}

/**
 * Slice 3 (#1169c): scope bindings carry a "kind" so call-site lowering
 * knows how to dispatch.
 *
 *   - `local`: params, let/const primitives, locally-built objects, and
 *     closures stored as values (the closure case sets `type` to
 *     `IrType.closure`). Reads emit `local.get`; if the type is `boxed`
 *     (ref cell), reads dereference via `refcell.get`.
 *   - `nestedFunc`: name-only binding for `function inner() {...}`.
 *     Calls expand into prepended-capture-args + direct call (matches
 *     the legacy `compileNestedFunctionDeclaration` pattern).
 *
 * Slice 6 (#1169e):
 *   - `slot`: a Wasm-local slot that survives across iterations of a
 *     for-of loop. Used for the loop variable AND for outer-scope `let`
 *     bindings that are mutated inside the loop body. Reads emit
 *     `slot.read`; writes emit `slot.write`. Once a name is bound as a
 *     slot, all subsequent reads/writes (including AFTER the for-of)
 *     route through the slot — this preserves the cross-iteration value
 *     semantics without requiring SSA phi nodes.
 */
type ScopeBinding =
  | { kind: "local"; value: IrValueId; type: IrType }
  | {
      kind: "nestedFunc";
      liftedName: string;
      signature: IrClosureSignature;
      captures: readonly NestedCapture[];
    }
  | {
      kind: "slot";
      slotIndex: number;
      /**
       * The slot's IR type as the binding sees it. For most slots this
       * equals the underlying Wasm-local type (e.g. `irVal({ kind:
       * "f64" })` for a numeric slot). For string-loop variables in
       * native-strings mode, this is `IrType.string` while the
       * underlying slot is `(ref $AnyString)` — see `asType` below.
       */
      type: IrType;
      /**
       * Slice 6 part 4 refactor (#1185): optional widening for
       * identifier reads. When present, the SSA result of a `slot.read`
       * against this binding is re-tagged to `asType` instead of
       * `irVal(slot.type)`. Used for native-strings string for-of
       * where the slot ValType is `(ref $AnyString)` but the loop
       * variable should compose with slice-1 string ops as
       * `IrType.string`.
       *
       * The Wasm-level value is identical between `slot.type` and
       * `asType` — `IrType.string` lowers to `(ref $AnyString)` in
       * native mode — so this is purely a type-system rewrite.
       */
      asType?: IrType;
    };

/**
 * Slice 3 (#1169c): one entry in a closure / nested-function's capture
 * set. `outerValue` is the SSA value the call-site uses to materialize
 * the capture argument; for mutable captures, the call-site wraps it
 * in a refcell on first use (rebinding `cx.scope` in-place so
 * subsequent outer reads/writes go through the cell).
 */
interface NestedCapture {
  readonly name: string;
  readonly type: IrType;
  readonly mutable: boolean;
  readonly outerValue: IrValueId;
}

interface LowerCtx {
  readonly builder: IrFunctionBuilder;
  readonly scope: Map<string, ScopeBinding>;
  readonly funcName: string;
  readonly returnType: IrType;
  readonly calleeTypes?: ReadonlyMap<string, { params: readonly IrType[]; returnType: IrType }>;
  /** Slice 4 (#1169d) — class shape registry, keyed by className. */
  readonly classShapes?: ReadonlyMap<string, IrClassShape>;
  /**
   * Slice 6 part 4 refactor (#1185) — from-ast view of the IR
   * resolver. Drives:
   *   - the string for-of strategy switch (`nativeStrings()`)
   *   - native-strings slot ValTypes (`resolveString()`)
   *   - vec element / data-array ValType inference (`resolveVec()`)
   *
   * Replaces the per-feature `nativeStrings: boolean` and
   * `anyStrTypeIdx: number` fields that #1183 added. Optional so
   * legacy callers (and tests) without resolver support work; the
   * for-of arms that need it throw a clean fall-back-to-legacy
   * error when it's absent.
   */
  readonly resolver?: IrFromAstResolver;
  /** Slice 3 — output bin for lifted closures / nested funcs. */
  readonly lifted: IrFunction[];
  /** Slice 3 — mutable counter for synthesizing lifted-func names. */
  readonly liftedCounter: { value: number };
  /**
   * Slice 6 part 2 (#1181) — names of `let` bindings that are mutated
   * somewhere in the function body (assignments via `=`, `+=`, `-=`,
   * `*=`, `/=`, or pre/postfix `++`/`--`). Mutated lets bind as a
   * `slot` ScopeBinding instead of `local` so cross-iteration writes
   * propagate correctly. Computed once per outer function in
   * `lowerFunctionAstToIr` via `collectMutatedLetNames`.
   */
  readonly mutatedLets: ReadonlySet<string>;
  /**
   * Slice 7a (#1169f): kind of function being lowered. `lowerYield`
   * checks this to refuse `yield` outside generators (defensive — the
   * selector should already have rejected the function). `lowerTail`
   * uses it to rewrite `return <expr>;` as a `gen.epilogue` + return
   * the externref Generator object, since a generator's IR-level
   * return type is externref regardless of source-level annotation.
   */
  readonly funcKind: "regular" | "generator" | "async";
  /**
   * Slice 7a (#1169f): for `funcKind === "generator"` only — the slot
   * index of the `__gen_buffer` Wasm-local. Reserved by the prologue
   * in `lowerFunctionAstToIr`. `lowerYield` reads this when emitting
   * `gen.push`; `lowerTail` reads it when emitting `gen.epilogue`.
   */
  readonly generatorBufferSlot?: number;
}

/**
 * Slice 6 part 2 (#1181): walk a function body to collect every `let`
 * name that is reassigned somewhere — `<id> = <expr>`, `<id> +=/-=/*=/`/=`
 * `<expr>`, or pre/postfix `++<id>`/`--<id>`/`<id>++`/`<id>--`. Names
 * that match are bound as `slot` ScopeBindings so the cross-iteration
 * write semantics inside for-of loops work correctly. Const-bound names
 * are not in scope for mutation; we only track identifier-LHS writes.
 *
 * We DON'T descend into nested function-likes — their writes are local
 * to their own scope and don't influence the outer's slot decisions.
 */
function collectMutatedLetNames(fn: ts.FunctionDeclaration): Set<string> {
  const writes = new Set<string>();
  if (!fn.body) return writes;
  return collectMutatedLetNamesFromBlock(fn.body);
}

function collectMutatedLetNamesFromBlock(body: ts.Block): Set<string> {
  const writes = new Set<string>();
  const visit = (node: ts.Node): void => {
    // Skip nested function bodies — their writes belong to their own
    // scope. The outer `mutatedLets` only governs outer-scope `let`s.
    if (
      node !== body &&
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node))
    ) {
      return;
    }
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      if (
        op === ts.SyntaxKind.EqualsToken ||
        (op >= ts.SyntaxKind.PlusEqualsToken && op <= ts.SyntaxKind.CaretEqualsToken)
      ) {
        if (ts.isIdentifier(node.left)) writes.add(node.left.text);
      }
    }
    if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
      const op = node.operator;
      if (op === ts.SyntaxKind.PlusPlusToken || op === ts.SyntaxKind.MinusMinusToken) {
        if (ts.isIdentifier(node.operand)) writes.add(node.operand.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(body, visit);
  return writes;
}

function lowerVarDecl(stmt: ts.VariableStatement, cx: LowerCtx): void {
  const isConst = !!(stmt.declarationList.flags & ts.NodeFlags.Const);
  for (const d of stmt.declarationList.declarations) {
    if (!ts.isIdentifier(d.name)) {
      throw new Error(`ir/from-ast: destructuring declarations not supported in Phase 1 (${cx.funcName})`);
    }
    const name = d.name.text;
    if (cx.scope.has(name)) {
      throw new Error(`ir/from-ast: redeclaration of '${name}' in ${cx.funcName}`);
    }
    if (!d.initializer) {
      throw new Error(`ir/from-ast: Phase 1 requires an initializer for '${name}' in ${cx.funcName}`);
    }
    // Slice 3 (#1169c): closure-literal initializer. Lifted to a
    // top-level IR function and bound in scope as an IrType.closure
    // value (so `lowerCall` dispatches via `closure.call`).
    if (isConst && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) {
      const value = lowerClosureExpression(d.initializer, cx);
      cx.scope.set(name, { kind: "local", value, type: cx.builder.typeOf(value) });
      continue;
    }
    // Slice 2 (#1169b): non-primitive type annotations on locals
    // (TypeLiteral / TypeReference) can't be resolved to an IrType
    // here without a TS checker. Defer those to inference from the
    // initializer — `typeNodeToIr` only fires for primitive type
    // keywords; everything else falls through to inference.
    const annotated =
      d.type && isPrimitiveTypeNode(d.type) ? typeNodeToIr(d.type, `local ${name} of ${cx.funcName}`) : undefined;
    const hint: IrType = annotated ?? irVal({ kind: "f64" });
    const value = lowerExpr(d.initializer, cx, hint);
    const inferred = cx.builder.typeOf(value);
    if (annotated) {
      // Slice 1 (#1169a): the IrType discriminator includes a `string` arm
      // alongside `val`, so use `irTypeEquals` for a structural match
      // rather than `asVal`-only kind comparison (which silently drops
      // the string case).
      if (!irTypeEquals(annotated, inferred)) {
        throw new Error(
          `ir/from-ast: local '${name}' annotated as ${describeIrType(annotated)} but initializer is ${describeIrType(inferred)} in ${cx.funcName}`,
        );
      }
    }
    // Slice 6 part 2 (#1181): mutable `let` bindings whose name is
    // reassigned anywhere in the function body bind as a `slot`
    // ScopeBinding instead of `local`. The slot is a Wasm-local that
    // survives across for-of iterations, and reads/writes go through
    // `slot.read` / `slot.write` instead of carrying the SSA value
    // through the scope.
    //
    // Slice 6 part 4 refactor (#1185): extended to support
    // `IrType.string` slot bindings via the resolver. In
    // native-strings mode we use the resolver's `resolveString()` to
    // get the underlying `(ref $AnyString)` ValType for the slot,
    // and tag the binding with `asType: IrType.string` so identifier
    // reads compose with slice-1 string ops.
    if (!isConst && cx.mutatedLets.has(name)) {
      const slotValType = asVal(inferred);
      if (slotValType !== null && slotValType.kind !== "ref" && slotValType.kind !== "ref_null") {
        const slotIndex = cx.builder.declareSlot(name, slotValType);
        cx.builder.emitSlotWrite(slotIndex, value);
        cx.scope.set(name, { kind: "slot", slotIndex, type: inferred });
        continue;
      }
      // String let in native-strings mode: slot ValType is the
      // resolver's string ref; binding type is IrType.string via
      // asType widening so body code composes with string ops.
      if (inferred.kind === "string") {
        const stringValType = cx.resolver?.resolveString?.();
        if (stringValType) {
          const slotIndex = cx.builder.declareSlot(name, stringValType);
          cx.builder.emitSlotWrite(slotIndex, value);
          cx.scope.set(name, {
            kind: "slot",
            slotIndex,
            type: irVal(stringValType),
            asType: { kind: "string" },
          });
          continue;
        }
      }
      // Fall through to local binding for non-slot-eligible types —
      // the lowerer will catch any subsequent assignment and throw,
      // landing the function back on the legacy path.
    }
    cx.scope.set(name, { kind: "local", value, type: inferred });
  }
}

function typeNodeToIr(node: ts.TypeNode | undefined, where: string): IrType {
  if (!node) throw new Error(`ir/from-ast: missing type annotation (${where})`);
  switch (node.kind) {
    case ts.SyntaxKind.NumberKeyword:
      return irVal({ kind: "f64" });
    case ts.SyntaxKind.BooleanKeyword:
      return irVal({ kind: "i32" });
    case ts.SyntaxKind.StringKeyword:
      return { kind: "string" };
    default:
      throw new Error(`ir/from-ast: unsupported type in Phase 1 (${where})`);
  }
}

/**
 * Quick predicate: does this TypeNode resolve to a primitive IrType
 * without needing a TS checker? Used by `lowerVarDecl` and
 * `resolveIrType` to decide whether to consult the override map.
 */
function isPrimitiveTypeNode(node: ts.TypeNode): boolean {
  return (
    node.kind === ts.SyntaxKind.NumberKeyword ||
    node.kind === ts.SyntaxKind.BooleanKeyword ||
    node.kind === ts.SyntaxKind.StringKeyword
  );
}

/** Short debug string for IrType, used in error messages. */
function describeIrType(t: IrType): string {
  if (t.kind === "val") return t.val.kind;
  if (t.kind === "string") return "string";
  if (t.kind === "object") {
    return `object{${t.shape.fields.map((f) => `${f.name}:${describeIrType(f.type)}`).join(",")}}`;
  }
  if (t.kind === "closure") {
    const ps = t.signature.params.map(describeIrType).join(",");
    return `closure(${ps})->${describeIrType(t.signature.returnType)}`;
  }
  if (t.kind === "class") return `class<${t.shape.className}>`;
  if (t.kind === "extern") return `extern<${t.className}>`;
  if (t.kind === "union") return `union<${t.members.map((m) => m.kind).join(",")}>`;
  return `boxed<${t.inner.kind}>`;
}

/**
 * Resolve the IR type for a function param or return.
 *
 * If the AST has an explicit TypeNode, it must agree with the override
 * (if any). If the AST has no TypeNode, the override is authoritative.
 * If neither is present, that's a compiler bug — the selector should not
 * have claimed this function.
 */
function resolveIrType(node: ts.TypeNode | undefined, override: IrType | undefined, where: string): IrType {
  if (node && isPrimitiveTypeNode(node)) {
    const fromNode = typeNodeToIr(node, where);
    if (override && !irTypeEquals(override, fromNode)) {
      throw new Error(
        `ir/from-ast: type override (${describeIrType(override)}) disagrees with annotation (${describeIrType(fromNode)}) at ${where}`,
      );
    }
    return fromNode;
  }
  // Slice 2 (#1169b): non-primitive TypeNodes (TypeLiteral / TypeReference)
  // need a TS checker to resolve into an IrType.object — we don't have
  // one inside the IR layer. The caller (codegen/index.ts:resolvePositionType)
  // pre-resolves these and passes the result via `override`, so we
  // simply prefer the override here. If neither is present, the
  // selector and override builder are out of sync — that's a bug.
  if (override) return override;
  throw new Error(`ir/from-ast: missing type annotation and no override (${where})`);
}

function lowerExpr(expr: ts.Expression, cx: LowerCtx, hint: IrType): IrValueId {
  if (ts.isParenthesizedExpression(expr)) {
    return lowerExpr(expr.expression, cx, hint);
  }
  if (ts.isNumericLiteral(expr)) {
    return cx.builder.emitConst({ kind: "f64", value: Number(expr.text) }, irVal({ kind: "f64" }));
  }
  if (expr.kind === ts.SyntaxKind.TrueKeyword) {
    return cx.builder.emitConst({ kind: "bool", value: true }, irVal({ kind: "i32" }));
  }
  if (expr.kind === ts.SyntaxKind.FalseKeyword) {
    return cx.builder.emitConst({ kind: "bool", value: false }, irVal({ kind: "i32" }));
  }
  // Slice 1 (#1169a) — strings, templates, typeof, .length, null-keyword.
  if (ts.isStringLiteral(expr) || expr.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral) {
    const lit = expr as ts.StringLiteral | ts.NoSubstitutionTemplateLiteral;
    return cx.builder.emitStringConst(lit.text);
  }
  if (ts.isTemplateExpression(expr)) {
    return lowerTemplateExpression(expr, cx);
  }
  if (ts.isTypeOfExpression(expr)) {
    return lowerTypeOf(expr, cx);
  }
  if (expr.kind === ts.SyntaxKind.NullKeyword) {
    // Bare `null` is only valid inside `=== null` / `!== null` (handled by
    // `tryFoldNullCompare` before we recurse into operands). Reaching here
    // means the selector accepted a context this slice can't lower.
    throw new Error(`ir/from-ast: bare 'null' outside === / !== is not supported in slice 1 (${cx.funcName})`);
  }
  if (ts.isPropertyAccessExpression(expr)) {
    return lowerPropertyAccess(expr, cx);
  }
  if (ts.isObjectLiteralExpression(expr)) {
    return lowerObjectLiteral(expr, cx);
  }
  if (ts.isElementAccessExpression(expr)) {
    return lowerElementAccess(expr, cx);
  }
  if (ts.isIdentifier(expr)) {
    const p = cx.scope.get(expr.text);
    if (!p) throw new Error(`ir/from-ast: identifier "${expr.text}" is not in scope in ${cx.funcName}`);
    // Slice 6 part 2 (#1181): slot-bound identifier (let mutated across
    // for-of iterations). Reads emit `slot.read`, which lowers to a
    // `local.get` on the Wasm-local slot. The slot's type is recorded
    // at declaration time so the IR result type matches.
    //
    // Slice 6 part 4 refactor (#1185): if the binding has an `asType`
    // widening, the SSA result is tagged as `asType` instead of
    // `irVal(slot.type)`. This lets native-strings string for-of
    // loop variables compose with slice-1 string ops even though the
    // underlying slot ValType is `(ref $AnyString)` rather than
    // `IrType.string`.
    if (p.kind === "slot") {
      if (p.asType) {
        return cx.builder.emitSlotReadAs(p.slotIndex, p.asType);
      }
      return cx.builder.emitSlotRead(p.slotIndex);
    }
    if (p.kind !== "local") {
      // Slice 3 (#1169c): nestedFunc bindings are name-only — they have
      // no SSA value. Bare reference (without a CallExpression) cannot
      // produce an IR value. The callable form is handled by `lowerCall`.
      throw new Error(`ir/from-ast: bare reference to nested function "${expr.text}" not in slice 3 (${cx.funcName})`);
    }
    // Slice 3 (#1169c): refcell-typed bindings need a deref on read.
    // The SSA value IS the cell ref; expression-position reads expect
    // the inner scalar.
    if (p.type.kind === "boxed") {
      return cx.builder.emitRefCellGet(p.value, p.type.inner);
    }
    return p.value;
  }
  if (ts.isPrefixUnaryExpression(expr)) {
    return lowerPrefixUnary(expr, cx);
  }
  if (ts.isBinaryExpression(expr)) {
    return lowerBinary(expr, cx);
  }
  if (ts.isConditionalExpression(expr)) {
    return lowerConditional(expr, cx);
  }
  if (ts.isCallExpression(expr)) {
    return lowerCall(expr, cx);
  }
  // Slice 4 (#1169d): class instantiation. Lookup must succeed against
  // the class registry seeded from `ctx.classShapes`; if not, the
  // function falls back to legacy.
  // Slice 10 (#1169i): extends to host extern classes — `new RegExp(...)`,
  // `new Uint8Array(N)`, etc. Dispatch happens inside `lowerNewExpression`
  // by checking the resolver's `getExternClassInfo` before the slice-4
  // class-shape lookup.
  if (ts.isNewExpression(expr)) {
    return lowerNewExpression(expr, cx);
  }
  // Slice 10 (#1169i): RegExp literal `/pattern/flags`. Lowers to
  // `extern.regex` which materializes the pattern + flags strings and
  // calls the `RegExp_new` host import.
  if (expr.kind === ts.SyntaxKind.RegularExpressionLiteral) {
    return lowerRegExpLiteral(expr, cx);
  }
  throw new Error(`ir/from-ast: unsupported expression kind ${ts.SyntaxKind[expr.kind]} in ${cx.funcName}`);
}

/**
 * Slice 10 (#1169i) — lower a `/pattern/flags` RegExp literal. Reuses the
 * legacy `parseRegExpLiteral` to extract pattern + flags from the literal
 * text. The flags string is normalized to `""` when no flags are present
 * (matches the legacy `compileRegExpLiteral` convention — see
 * `src/codegen/typeof-delete.ts:166-168`); a `null` flags arg would
 * otherwise produce `RegExp("...", null)` at runtime, which JS rejects
 * as `TypeError: Invalid flags 'null'`.
 */
function lowerRegExpLiteral(expr: ts.Expression, cx: LowerCtx): IrValueId {
  const { pattern, flags } = parseRegExpLiteralText(expr.getText());
  return cx.builder.emitRegExpLiteral(pattern, flags);
}

/**
 * Slice 10 (#1169i) — local copy of the legacy `parseRegExpLiteral` (in
 * `src/codegen/index.ts:3218`). Duplicated here to avoid importing from
 * `codegen/index.ts` from `ir/from-ast.ts`, which would add a second
 * pass-through over the existing `codegen/index.ts ↔ ir/integration.ts`
 * circular dependency. The two implementations are trivially identical;
 * any drift would surface as a behavioural mismatch in the slice-10
 * equivalence tests.
 */
function parseRegExpLiteralText(text: string): { pattern: string; flags: string } {
  const lastSlash = text.lastIndexOf("/");
  return { pattern: text.slice(1, lastSlash), flags: text.slice(lastSlash + 1) };
}

/**
 * Lower a template literal with substitutions. Slice 1 (#1169a) restricts
 * substitutions to expressions that lower to `IrType.string`. Mixed-type
 * substitutions (number/boolean coerced to string) require `number_toString`
 * plumbing through `IrInstrCall` and are deferred.
 *
 * Even when the head text is empty (`${x}rest`) we emit a `string.const ""`
 * to give the chain a consistent left operand for the first concat — same
 * convention as the legacy `compileTemplateExpression`. The IR
 * constant-folder may collapse trivial empty-concats downstream.
 */
function lowerTemplateExpression(expr: ts.TemplateExpression, cx: LowerCtx): IrValueId {
  let acc = cx.builder.emitStringConst(expr.head.text);
  for (const span of expr.templateSpans) {
    const sub = lowerExpr(span.expression, cx, { kind: "string" });
    const subType = cx.builder.typeOf(sub);
    if (subType.kind !== "string") {
      throw new Error(
        `ir/from-ast: template substitution must be string in slice 1 (got ${describeIrType(subType)} in ${cx.funcName})`,
      );
    }
    acc = cx.builder.emitStringConcat(acc, sub);
    if (span.literal.text) {
      const lit = cx.builder.emitStringConst(span.literal.text);
      acc = cx.builder.emitStringConcat(acc, lit);
    }
  }
  return acc;
}

/**
 * Lower `typeof <expr>` by static fold (slice 1). Operand IrType must be
 * statically known; union/boxed operands are deferred to a follow-up
 * slice that emits a runtime tag dispatch via `tag.test`.
 */
function lowerTypeOf(expr: ts.TypeOfExpression, cx: LowerCtx): IrValueId {
  const inner = lowerExpr(expr.expression, cx, irVal({ kind: "f64" }));
  const innerType = cx.builder.typeOf(inner);
  const tag = staticTypeOfFor(innerType);
  if (tag === null) {
    throw new Error(
      `ir/from-ast: typeof of non-static IrType (${describeIrType(innerType)}) is deferred (${cx.funcName})`,
    );
  }
  return cx.builder.emitStringConst(tag);
}

/**
 * Map an IR type to the JS `typeof` tag string that any value of that type
 * would produce at runtime. Returns `null` for types whose runtime tag
 * varies (unions, boxed, references) — those need a runtime dispatch and
 * are out of slice 1's scope.
 */
function staticTypeOfFor(t: IrType): string | null {
  if (t.kind === "string") return "string";
  if (t.kind === "val") {
    if (t.val.kind === "f64" || t.val.kind === "f32" || t.val.kind === "i64") return "number";
    if (t.val.kind === "i32") return "boolean"; // i32 represents bool in slice 1
  }
  return null;
}

/**
 * Lower a property access expression.
 *
 * Slice 1 (#1169a) handles `<string>.length` (the only `.length` form
 * relevant before slice 2). Slice 2 (#1169b) extends to named property
 * reads on `IrType.object` receivers — the lowerer resolves the field
 * by name against the receiver shape's canonical field list and emits
 * `object.get`.
 *
 * Receivers of any other IrType (boxed, union, val with non-string
 * representation) are out of slice 2's scope and throw, so the
 * containing function falls back to legacy.
 */
function lowerPropertyAccess(expr: ts.PropertyAccessExpression, cx: LowerCtx): IrValueId {
  if (!ts.isIdentifier(expr.name)) {
    throw new Error(`ir/from-ast: computed property access not in slice 2 (${cx.funcName})`);
  }
  const propName = expr.name.text;

  // Receiver type is unknown until we lower it; pass an f64 hint (the
  // numeric default) and inspect the resulting IrType. The hint is
  // advisory — string / object lowerings ignore it.
  const recv = lowerExpr(expr.expression, cx, irVal({ kind: "f64" }));
  const recvType = cx.builder.typeOf(recv);

  if (recvType.kind === "string") {
    // Slice 1 — only `.length` is supported on string receivers.
    if (propName !== "length") {
      throw new Error(`ir/from-ast: .${propName} on string is not in slice 2 (${cx.funcName})`);
    }
    return cx.builder.emitStringLen(recv);
  }

  if (recvType.kind === "object") {
    // Slice 2 — named field read on a known shape.
    const fieldIdx = recvType.shape.fields.findIndex((f) => f.name === propName);
    if (fieldIdx < 0) {
      throw new Error(
        `ir/from-ast: object has no field "${propName}" (shape: ${describeIrType(recvType)}) in ${cx.funcName}`,
      );
    }
    const fieldType = recvType.shape.fields[fieldIdx]!.type;
    return cx.builder.emitObjectGet(recv, propName, fieldType);
  }

  if (recvType.kind === "class") {
    // Slice 4 (#1169d) — named field read on a class instance. Static
    // resolution: look up `propName` against the class shape's field
    // list. Methods are not readable as bare property access in slice 4
    // (no method-as-value); only call expressions resolve them.
    const field = recvType.shape.fields.find((f) => f.name === propName);
    if (!field) {
      throw new Error(`ir/from-ast: class ${recvType.shape.className} has no field "${propName}" in ${cx.funcName}`);
    }
    return cx.builder.emitClassGet(recv, propName, field.type);
  }

  if (recvType.kind === "extern") {
    // Slice 10 (#1169i) — extern-class property read. Look up the
    // property on the resolver's metadata for `recvType.className`.
    // Result type is `irVal(prop.type)`; the lowerer emits a call to
    // `<className>_get_<propName>`.
    const className = recvType.className;
    const info = cx.resolver?.getExternClassInfo?.(className);
    if (!info) {
      throw new Error(`ir/from-ast: extern class ${className} not registered in ${cx.funcName}`);
    }
    const prop = info.properties.get(propName);
    if (!prop) {
      throw new Error(`ir/from-ast: extern class ${className} has no property "${propName}" in ${cx.funcName}`);
    }
    return cx.builder.emitExternProp(className, propName, recv, irVal(prop.type));
  }

  throw new Error(
    `ir/from-ast: property access .${propName} on ${describeIrType(recvType)} is not in slice 2 (${cx.funcName})`,
  );
}

/**
 * Lower an object literal to an IR `object.new`. The shape is derived
 * from the literal's properties: each PropertyAssignment /
 * ShorthandPropertyAssignment contributes one field. Field types come
 * from the lowered initializer's IrType (no TS-checker introspection
 * — we're already past type resolution by the time we lower).
 *
 * The shape is sorted by name AFTER lowering so the canonical form
 * compares equal across literals with different syntactic ordering. The
 * value list is reordered to match.
 */
function lowerObjectLiteral(expr: ts.ObjectLiteralExpression, cx: LowerCtx): IrValueId {
  if (expr.properties.length === 0) {
    throw new Error(`ir/from-ast: empty object literal not in slice 2 (${cx.funcName})`);
  }
  const built: { name: string; type: IrType; value: IrValueId }[] = [];
  const seen = new Set<string>();
  for (const prop of expr.properties) {
    if (ts.isPropertyAssignment(prop)) {
      const name = phase1PropertyName(prop.name);
      if (name === null) {
        throw new Error(`ir/from-ast: object literal property name not in slice 2 (${cx.funcName})`);
      }
      if (seen.has(name)) {
        throw new Error(`ir/from-ast: duplicate object literal key "${name}" not in slice 2 (${cx.funcName})`);
      }
      seen.add(name);
      const v = lowerExpr(prop.initializer, cx, irVal({ kind: "f64" }));
      const type = cx.builder.typeOf(v);
      built.push({ name, type, value: v });
      continue;
    }
    if (ts.isShorthandPropertyAssignment(prop)) {
      const name = prop.name.text;
      if (seen.has(name)) {
        throw new Error(`ir/from-ast: duplicate object literal key "${name}" not in slice 2 (${cx.funcName})`);
      }
      seen.add(name);
      const found = cx.scope.get(name);
      if (!found) {
        throw new Error(`ir/from-ast: shorthand "${name}" not in scope in ${cx.funcName}`);
      }
      // Slice 3 (#1169c): only `local`-kind bindings are usable as
      // shorthand object property values. nestedFunc bindings have no
      // SSA value.
      if (found.kind !== "local") {
        throw new Error(`ir/from-ast: shorthand "${name}" refers to a non-local binding (${cx.funcName})`);
      }
      // If the local is refcell-typed, deref to expose the inner scalar
      // (the same logic the identifier-handler in lowerExpr applies).
      if (found.type.kind === "boxed") {
        const v = cx.builder.emitRefCellGet(found.value, found.type.inner);
        built.push({ name, type: cx.builder.typeOf(v), value: v });
      } else {
        built.push({ name, type: found.type, value: found.value });
      }
      continue;
    }
    throw new Error(`ir/from-ast: object literal element ${ts.SyntaxKind[prop.kind]} not in slice 2 (${cx.funcName})`);
  }
  built.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const shape: IrObjectShape = {
    fields: built.map((b) => ({ name: b.name, type: b.type })),
  };
  return cx.builder.emitObjectNew(
    shape,
    built.map((b) => b.value),
  );
}

/**
 * Lower an element access whose argument is a string literal — sugar
 * for property access on a known shape. Numeric / computed keys are
 * out of slice 2's scope and throw, so the function falls back to
 * legacy.
 */
function lowerElementAccess(expr: ts.ElementAccessExpression, cx: LowerCtx): IrValueId {
  const arg = expr.argumentExpression;
  if (!ts.isStringLiteral(arg) && arg.kind !== ts.SyntaxKind.NoSubstitutionTemplateLiteral) {
    throw new Error(`ir/from-ast: non-string-literal element access not in slice 2 (${cx.funcName})`);
  }
  const propName = (arg as ts.StringLiteral | ts.NoSubstitutionTemplateLiteral).text;
  const recv = lowerExpr(expr.expression, cx, irVal({ kind: "f64" }));
  const recvType = cx.builder.typeOf(recv);
  if (recvType.kind !== "object") {
    throw new Error(`ir/from-ast: element access on ${describeIrType(recvType)} is not in slice 2 (${cx.funcName})`);
  }
  const fieldIdx = recvType.shape.fields.findIndex((f) => f.name === propName);
  if (fieldIdx < 0) {
    throw new Error(
      `ir/from-ast: object has no field "${propName}" (shape: ${describeIrType(recvType)}) in ${cx.funcName}`,
    );
  }
  const fieldType = recvType.shape.fields[fieldIdx]!.type;
  return cx.builder.emitObjectGet(recv, propName, fieldType);
}

/**
 * Resolve an object literal property name to a string. Identifier and
 * StringLiteral keys produce their text. NumericLiteral keys produce
 * the canonical JS toString of the number. ComputedPropertyName always
 * returns null. Duplicated locally from select.ts to avoid a circular
 * import.
 */
function phase1PropertyName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name)) return name.text;
  if (ts.isNumericLiteral(name)) return name.text;
  return null;
}

/**
 * Lower a direct call to a locally-declared function. The callee's signature
 * comes from `calleeTypes` (seeded by the Phase-2 TypeMap via the caller).
 * If the callee isn't in the map, the selector's call-graph closure was
 * violated — we throw so the caller can fall back to the legacy path.
 *
 * Arg type mismatch is fatal too: the selector is supposed to keep the
 * whole strongly-connected component on the IR path only when the types
 * are consistent. If we land here with a mismatch, the TypeMap was stale
 * or the propagation pass converged on a dynamic type that the selector
 * ignored — both are bugs.
 */
function lowerCall(expr: ts.CallExpression, cx: LowerCtx): IrValueId {
  // Slice 4 (#1169d): method call — `<recv>.<methodName>(args)`. The
  // receiver must lower to an IrType.class; the method must exist on
  // the class shape and be non-void (slice 4 only handles methods with
  // a returning result in expression position).
  if (ts.isPropertyAccessExpression(expr.expression)) {
    return lowerMethodCall(expr, cx);
  }
  if (!ts.isIdentifier(expr.expression)) {
    throw new Error(`ir/from-ast: only direct calls supported in Phase 2 (${cx.funcName})`);
  }
  const calleeName = expr.expression.text;

  // Slice 3 (#1169c): local-binding lookups WIN over top-level callees
  // because the source-level identifier resolution puts inner-scope
  // names first. The dispatcher picks one of three paths:
  //   - `local` binding whose IrType is closure → closure.call
  //   - `nestedFunc` binding → direct call with prepended captures
  //   - top-level callee in calleeTypes → vanilla `call`
  const binding = cx.scope.get(calleeName);
  if (binding?.kind === "local" && binding.type.kind === "closure") {
    return lowerClosureCall(binding.value, binding.type.signature, expr.arguments, cx);
  }
  if (binding?.kind === "nestedFunc") {
    return lowerNestedFuncCall(binding, expr.arguments, cx);
  }

  const calleeSig = cx.calleeTypes?.get(calleeName);
  if (!calleeSig) {
    throw new Error(`ir/from-ast: call to unknown function "${calleeName}" in ${cx.funcName}`);
  }
  if (expr.arguments.length !== calleeSig.params.length) {
    throw new Error(
      `ir/from-ast: call to ${calleeName} has ${expr.arguments.length} args, expected ${calleeSig.params.length} in ${cx.funcName}`,
    );
  }
  const args: IrValueId[] = [];
  for (let i = 0; i < expr.arguments.length; i++) {
    const argExpr = expr.arguments[i]!;
    const expected = calleeSig.params[i]!;
    const argVal = lowerExpr(argExpr, cx, expected);
    const argType = cx.builder.typeOf(argVal);
    if (!irTypeEquals(argType, expected)) {
      throw new Error(
        `ir/from-ast: arg ${i} of call to ${calleeName} is ${describeIrType(argType)}, expected ${describeIrType(expected)} in ${cx.funcName}`,
      );
    }
    args.push(argVal);
  }
  const result = cx.builder.emitCall({ kind: "func", name: calleeName }, args, calleeSig.returnType);
  if (result === null) {
    throw new Error(`ir/from-ast: call to ${calleeName} returned void used as expression in ${cx.funcName}`);
  }
  return result;
}

/**
 * Slice 3 (#1169c): lower a call-by-value to a closure binding.
 * `callee` is the SSA value of the closure struct. The lowered
 * `closure.call` instr emits `<callee>; args; <callee>; struct.get
 * $func; call_ref` — the second `<callee>` use is forced into a Wasm
 * local by `collectIrUses`'s double count.
 */
function lowerClosureCall(
  callee: IrValueId,
  signature: IrClosureSignature,
  argExprs: readonly ts.Expression[],
  cx: LowerCtx,
): IrValueId {
  if (argExprs.length !== signature.params.length) {
    throw new Error(`ir/from-ast: closure call arity mismatch in ${cx.funcName}`);
  }
  const args: IrValueId[] = [];
  for (let i = 0; i < argExprs.length; i++) {
    const expected = signature.params[i]!;
    const argVal = lowerExpr(argExprs[i]!, cx, expected);
    if (!irTypeEquals(cx.builder.typeOf(argVal), expected)) {
      throw new Error(
        `ir/from-ast: closure arg ${i} type mismatch (expected ${describeIrType(expected)}, got ${describeIrType(cx.builder.typeOf(argVal))}) in ${cx.funcName}`,
      );
    }
    args.push(argVal);
  }
  return cx.builder.emitClosureCall(callee, args, signature.returnType);
}

/**
 * Slice 3 (#1169c): lower a call to a nested function declaration.
 * Prepends capture args to the user args and emits a direct `call`
 * (no struct, no funcref) — matches the legacy
 * `compileNestedFunctionDeclaration` pattern.
 *
 * Mutable captures: if the outer hasn't already wrapped the variable
 * in a refcell (because no closure-VALUE has been built that captured
 * it as mutable), wrap it here and rebind `cx.scope[name]` so subsequent
 * outer reads/writes go through the cell.
 */
function lowerNestedFuncCall(
  binding: {
    kind: "nestedFunc";
    liftedName: string;
    signature: IrClosureSignature;
    captures: readonly NestedCapture[];
  },
  argExprs: readonly ts.Expression[],
  cx: LowerCtx,
): IrValueId {
  if (argExprs.length !== binding.signature.params.length) {
    throw new Error(`ir/from-ast: nested func call arity mismatch in ${cx.funcName}`);
  }
  const args: IrValueId[] = [];
  for (const cap of binding.captures) {
    const live = cx.scope.get(cap.name);
    if (cap.mutable) {
      if (live?.kind === "local" && live.type.kind === "boxed") {
        args.push(live.value);
      } else if (live?.kind === "local") {
        const innerVal = asVal(cap.type);
        if (!innerVal) {
          throw new Error(`ir/from-ast: mutable nested capture "${cap.name}" must be a primitive (${cx.funcName})`);
        }
        const cell = cx.builder.emitRefCellNew(live.value, innerVal);
        cx.scope.set(cap.name, { kind: "local", value: cell, type: { kind: "boxed", inner: innerVal } });
        args.push(cell);
      } else {
        throw new Error(`ir/from-ast: nested mutable capture "${cap.name}" not in scope (${cx.funcName})`);
      }
    } else {
      // Read-only capture — read the CURRENT value from outer scope. If
      // an earlier sibling's mutable capture upgraded the binding to a
      // refcell, deref through it.
      if (live?.kind === "local" && live.type.kind === "boxed") {
        const v = cx.builder.emitRefCellGet(live.value, live.type.inner);
        args.push(v);
      } else if (live?.kind === "local") {
        args.push(live.value);
      } else {
        throw new Error(`ir/from-ast: nested capture "${cap.name}" not in scope (${cx.funcName})`);
      }
    }
  }
  for (let i = 0; i < argExprs.length; i++) {
    const expected = binding.signature.params[i]!;
    const argVal = lowerExpr(argExprs[i]!, cx, expected);
    if (!irTypeEquals(cx.builder.typeOf(argVal), expected)) {
      throw new Error(
        `ir/from-ast: nested arg ${i} type mismatch (expected ${describeIrType(expected)}, got ${describeIrType(cx.builder.typeOf(argVal))}) in ${cx.funcName}`,
      );
    }
    args.push(argVal);
  }
  const r = cx.builder.emitCall({ kind: "func", name: binding.liftedName }, args, binding.signature.returnType);
  if (r === null) {
    throw new Error(`ir/from-ast: nested call returned void in ${cx.funcName}`);
  }
  return r;
}

// ---------------------------------------------------------------------------
// Class lowering (#1169d — IR Phase 4 Slice 4)
// ---------------------------------------------------------------------------

/**
 * Slice 4 (#1169d): lower a `new ClassName(args)` expression.
 *
 * The class shape is looked up against `cx.classShapes`. Argument types
 * must match the constructor's declared `constructorParams`. Generic
 * type-arguments are not supported (the selector rejects them).
 *
 * Returns the SSA value of the constructed instance — its IrType is
 * `{ kind: "class", shape }` so subsequent property accesses / method
 * calls dispatch correctly.
 */
function lowerNewExpression(expr: ts.NewExpression, cx: LowerCtx): IrValueId {
  if (!ts.isIdentifier(expr.expression)) {
    throw new Error(`ir/from-ast: only direct constructor names supported in slice 4 (${cx.funcName})`);
  }
  const className = expr.expression.text;

  // Slice 10 (#1169i): host extern class (RegExp, Uint8Array, …) takes
  // priority over the slice-4 class registry — the legacy externClasses
  // map is the source of truth for built-in constructors. The result is
  // tagged as `IrType.extern { className }` so subsequent
  // `recv.method(...)` and `recv.prop` access can dispatch through the
  // extern path.
  const externInfo = cx.resolver?.getExternClassInfo?.(className);
  if (externInfo) {
    const argExprs = expr.arguments ?? [];
    // Constructor arity is permissive: the legacy host imports often
    // accept fewer args than `constructorParams` reports (the optional
    // / overload arms collapse). We don't enforce a strict equality
    // here — extra args are an error, but missing args silently pad
    // with sentinel values matching the legacy convention. For step A
    // (RegExp), `new RegExp(pattern)` and `new RegExp(pattern, flags)`
    // are both valid; for slice-10 step C (TypedArrays), `new
    // Uint8Array(N)` matches a single-param overload.
    if (argExprs.length > externInfo.constructorParams.length) {
      throw new Error(
        `ir/from-ast: new ${className}(...) has ${argExprs.length} args, max ${externInfo.constructorParams.length} in ${cx.funcName}`,
      );
    }
    const args: IrValueId[] = [];
    for (let i = 0; i < argExprs.length; i++) {
      const expectedTy = externInfo.constructorParams[i]!;
      const hint = irVal(expectedTy);
      const argVal = lowerExpr(argExprs[i]!, cx, hint);
      args.push(coerceToExpectedExtern(argVal, expectedTy, cx, `arg ${i} of new ${className}`));
    }
    // Pad missing optional args with default sentinels so the host
    // `<className>_new` import receives the right Wasm arity. Mirrors
    // the legacy `compileNewExpression` extern path (see
    // `src/codegen/expressions/new-super.ts:2200-2203`'s
    // `pushDefaultValue` loop). For step A (RegExp): missing flags arg
    // pads as `ref.null.extern`, which the host's `RegExp_new` stub
    // converts to `undefined` flags via the JS host import shim — JS
    // accepts `new RegExp(p, undefined)` as "no flags" while rejecting
    // `new RegExp(p, null)` as TypeError "Invalid flags 'null'". The
    // legacy uses `emitUndefinedValue` for the same reason; the IR
    // path leans on the host import shim's null-vs-undefined treatment
    // (the shim treats `ref.null.extern` as undefined).
    for (let i = argExprs.length; i < externInfo.constructorParams.length; i++) {
      const expectedTy = externInfo.constructorParams[i]!;
      args.push(emitDefaultExternArg(cx, expectedTy));
    }
    return cx.builder.emitExternNew(className, args);
  }

  const shape = cx.classShapes?.get(className);
  if (!shape) {
    throw new Error(`ir/from-ast: unknown class "${className}" in ${cx.funcName}`);
  }
  const argExprs = expr.arguments ?? [];
  if (argExprs.length !== shape.constructorParams.length) {
    throw new Error(
      `ir/from-ast: new ${className}(...) has ${argExprs.length} args, expected ${shape.constructorParams.length} in ${cx.funcName}`,
    );
  }
  const args: IrValueId[] = [];
  for (let i = 0; i < argExprs.length; i++) {
    const expected = shape.constructorParams[i]!;
    const argVal = lowerExpr(argExprs[i]!, cx, expected);
    const argType = cx.builder.typeOf(argVal);
    if (!irTypeEquals(argType, expected)) {
      throw new Error(
        `ir/from-ast: arg ${i} of new ${className}(...) is ${describeIrType(argType)}, expected ${describeIrType(expected)} in ${cx.funcName}`,
      );
    }
    args.push(argVal);
  }
  return cx.builder.emitClassNew(shape, args);
}

/**
 * Slice 10 (#1169i) — coerce an SSA value to the ValType expected by an
 * extern-class import param. The legacy host imports take ValType-typed
 * params (most often `externref` for ref-shaped args, `f64` for numeric
 * args). The IR's static types may not match exactly:
 *   - `IrType.string` in host-strings mode is already externref → no-op.
 *   - `IrType.string` in native-strings mode is `(ref $AnyString)` → the
 *     verifier would reject the type mismatch, so for slice-10 we reject
 *     this case and fall back to legacy. (TODO follow-up: thread native-
 *     strings string args through `extern.convert_any` before the call.)
 *   - `IrType.extern { ... }` is externref → no-op when expected is
 *     externref.
 *   - `IrType.val { f64 }` matches `f64`.
 *   - Mismatches throw and the function falls back to legacy.
 *
 * Returns the (possibly identical) SSA value to push.
 */
/**
 * Slice 10 (#1169i) — emit a default sentinel SSA value for a missing
 * optional arg in an extern-class constructor or method call. Mirrors
 * `pushDefaultValue` in `src/codegen/type-coercion.ts:2093` for the
 * subset of ValTypes the IR's extern path encounters:
 *   - externref → `ref.null.extern` (host shim treats as `undefined`)
 *   - f64 → `0`
 *   - i32 → `0`
 *   - i64 → `0n`
 * Other ValTypes throw — slice 10 doesn't see them in the legacy
 * extern-class signatures we deal with.
 */
function emitDefaultExternArg(cx: LowerCtx, expected: ValType): IrValueId {
  switch (expected.kind) {
    case "externref":
      return cx.builder.emitConst({ kind: "null", ty: irVal(expected) }, irVal(expected));
    case "f64":
      return cx.builder.emitConst({ kind: "f64", value: 0 }, irVal(expected));
    case "i32":
      return cx.builder.emitConst({ kind: "i32", value: 0 }, irVal(expected));
    case "i64":
      return cx.builder.emitConst({ kind: "i64", value: 0n }, irVal(expected));
    default:
      throw new Error(`ir/from-ast: cannot pad default arg of type ${expected.kind} (${cx.funcName})`);
  }
}

function coerceToExpectedExtern(value: IrValueId, expected: ValType, cx: LowerCtx, where: string): IrValueId {
  const t = cx.builder.typeOf(value);
  // Same-kind val match (e.g. f64 → f64).
  const got = asVal(t);
  if (got && got.kind === expected.kind) {
    return value;
  }
  // String → externref: in host-strings mode, IrType.string is already
  // externref; the verifier sees the SSA type as `string` but the Wasm
  // valtype is externref so the host call accepts it transparently.
  // We keep the SSA type as-is and rely on the lowerer's ValType
  // resolution.
  if (expected.kind === "externref" && t.kind === "string" && !cx.resolver?.nativeStrings?.()) {
    return value;
  }
  // extern → externref: extern values are externref-shaped.
  if (expected.kind === "externref" && t.kind === "extern") {
    return value;
  }
  throw new Error(`ir/from-ast: ${where} expects ${expected.kind} but got ${describeIrType(t)} (${cx.funcName})`);
}

/**
 * Slice 4 (#1169d): lower `<recv>.<methodName>(args)` on a class
 * receiver. The receiver is lowered first (so we can inspect its
 * IrType); the method's signature is looked up against the receiver's
 * class shape; argument types must match. Returns the SSA value of the
 * call result — throws if the method is void (slice 4 rejects void
 * methods in expression position; statement-position void calls go
 * through the bare ExpressionStatement path).
 *
 * Receivers of any IrType other than `class` fall through to a clean
 * error, letting the function fall back to legacy.
 */
function lowerMethodCall(expr: ts.CallExpression, cx: LowerCtx): IrValueId {
  if (!ts.isPropertyAccessExpression(expr.expression) || !ts.isIdentifier(expr.expression.name)) {
    throw new Error(`ir/from-ast: malformed method call in ${cx.funcName}`);
  }
  const methodName = expr.expression.name.text;
  const recv = lowerExpr(expr.expression.expression, cx, irVal({ kind: "f64" }));
  const recvType = cx.builder.typeOf(recv);

  // Slice 10 (#1169i) — extern-class method call. The legacy host imports
  // store the signature as `[receiver_externref, ...userParams] ->
  // results`, so we slice off `params[0]` when matching call args.
  if (recvType.kind === "extern") {
    const className = recvType.className;
    const info = cx.resolver?.getExternClassInfo?.(className);
    if (!info) {
      throw new Error(`ir/from-ast: extern class ${className} not registered in ${cx.funcName}`);
    }
    const method = info.methods.get(methodName);
    if (!method) {
      throw new Error(`ir/from-ast: extern class ${className} has no method "${methodName}" in ${cx.funcName}`);
    }
    // params[0] is the receiver — userParams = params.slice(1).
    const userParams = method.params.slice(1);
    if (expr.arguments.length > userParams.length) {
      throw new Error(
        `ir/from-ast: method ${className}.${methodName} has ${expr.arguments.length} args, max ${userParams.length} in ${cx.funcName}`,
      );
    }
    const args: IrValueId[] = [];
    for (let i = 0; i < expr.arguments.length; i++) {
      const expected = userParams[i]!;
      const argVal = lowerExpr(expr.arguments[i]!, cx, irVal(expected));
      args.push(coerceToExpectedExtern(argVal, expected, cx, `arg ${i} of ${className}.${methodName}`));
    }
    // Result type: first registered result, or null if void.
    const resultType: IrType | null = method.results.length > 0 ? irVal(method.results[0]!) : null;
    if (resultType === null) {
      throw new Error(
        `ir/from-ast: void method ${className}.${methodName} used in expression position (${cx.funcName})`,
      );
    }
    const r = cx.builder.emitExternCall(className, methodName, recv, args, resultType);
    if (r === null) {
      throw new Error(`ir/from-ast: extern.call produced no result in ${cx.funcName}`);
    }
    return r;
  }

  if (recvType.kind !== "class") {
    throw new Error(
      `ir/from-ast: method call .${methodName}(...) on ${describeIrType(recvType)} not in slice 4 (${cx.funcName})`,
    );
  }
  const method = recvType.shape.methods.find((m) => m.name === methodName);
  if (!method) {
    throw new Error(`ir/from-ast: class ${recvType.shape.className} has no method "${methodName}" in ${cx.funcName}`);
  }
  if (expr.arguments.length !== method.params.length) {
    throw new Error(
      `ir/from-ast: method ${recvType.shape.className}.${methodName} has ${expr.arguments.length} args, expected ${method.params.length} in ${cx.funcName}`,
    );
  }
  const args: IrValueId[] = [];
  for (let i = 0; i < expr.arguments.length; i++) {
    const expected = method.params[i]!;
    const argVal = lowerExpr(expr.arguments[i]!, cx, expected);
    const argType = cx.builder.typeOf(argVal);
    if (!irTypeEquals(argType, expected)) {
      throw new Error(
        `ir/from-ast: arg ${i} of ${recvType.shape.className}.${methodName} is ${describeIrType(argType)}, expected ${describeIrType(expected)} in ${cx.funcName}`,
      );
    }
    args.push(argVal);
  }
  if (method.returnType === null) {
    throw new Error(
      `ir/from-ast: void method ${recvType.shape.className}.${methodName} used in expression position (${cx.funcName})`,
    );
  }
  const r = cx.builder.emitClassCall(recv, methodName, args, method.returnType);
  if (r === null) {
    // Defensive — emitClassCall returns null only when resultType is null.
    throw new Error(`ir/from-ast: class.call produced no result in ${cx.funcName}`);
  }
  return r;
}

/**
 * Slice 4 (#1169d): lower `<obj>.<field> = <expr>;` as `class.set` (or
 * `object.set`, depending on the receiver's IrType). Statement-position
 * only — caller (in `lowerStatementList`) has already verified shape.
 *
 * For class receivers: validate `fieldName` exists on the shape and
 * the RHS type matches the field type. For object receivers: same idea
 * via the slice-2 `object.set`. Anything else throws and the function
 * falls back to legacy.
 */
function lowerPropertyAssignment(expr: ts.BinaryExpression, cx: LowerCtx): void {
  const lhs = expr.left;
  if (!ts.isPropertyAccessExpression(lhs) || !ts.isIdentifier(lhs.name)) {
    throw new Error(`ir/from-ast: malformed property assignment LHS in ${cx.funcName}`);
  }
  const fieldName = lhs.name.text;
  const recv = lowerExpr(lhs.expression, cx, irVal({ kind: "f64" }));
  const recvType = cx.builder.typeOf(recv);

  if (recvType.kind === "class") {
    const field = recvType.shape.fields.find((f) => f.name === fieldName);
    if (!field) {
      throw new Error(`ir/from-ast: class ${recvType.shape.className} has no field "${fieldName}" in ${cx.funcName}`);
    }
    const newValue = lowerExpr(expr.right, cx, field.type);
    const newValueType = cx.builder.typeOf(newValue);
    if (!irTypeEquals(newValueType, field.type)) {
      throw new Error(
        `ir/from-ast: assignment to ${recvType.shape.className}.${fieldName} (${describeIrType(field.type)}) got ${describeIrType(newValueType)} (${cx.funcName})`,
      );
    }
    cx.builder.emitClassSet(recv, fieldName, newValue);
    return;
  }

  if (recvType.kind === "object") {
    const fieldIdx = recvType.shape.fields.findIndex((f) => f.name === fieldName);
    if (fieldIdx < 0) {
      throw new Error(
        `ir/from-ast: object has no field "${fieldName}" (shape: ${describeIrType(recvType)}) in ${cx.funcName}`,
      );
    }
    const fieldType = recvType.shape.fields[fieldIdx]!.type;
    const newValue = lowerExpr(expr.right, cx, fieldType);
    const newValueType = cx.builder.typeOf(newValue);
    if (!irTypeEquals(newValueType, fieldType)) {
      throw new Error(
        `ir/from-ast: assignment to .${fieldName} (${describeIrType(fieldType)}) got ${describeIrType(newValueType)} (${cx.funcName})`,
      );
    }
    cx.builder.emitObjectSet(recv, fieldName, newValue);
    return;
  }

  throw new Error(`ir/from-ast: property assignment on ${describeIrType(recvType)} is not in slice 4 (${cx.funcName})`);
}

// ---------------------------------------------------------------------------
// for-of statement lowering (slice 6 part 2 — #1181)
// ---------------------------------------------------------------------------
//
// Activates the slice-6 IR scaffolding shipped by #1169e. Lowers
// `for (const x of arr)` over a vec ref to a `forof.vec` declarative
// instr, with the loop variable bound as a `slot` ScopeBinding inside
// the body. Body statements go through `lowerStmt` (separate from
// `lowerStatementList` — the body is non-tail, no early-return / nested
// closures, just simple statement forms).
//
// Iterables that don't lower to a `(ref|ref_null) $vec_*` ValType throw
// and the function falls back to legacy. The iterator-protocol path
// (Map / Set / generators) lands in #1182.

// ---------------------------------------------------------------------------
// yield lowering (slice 7a — #1169f)
// ---------------------------------------------------------------------------

/**
 * Slice 7a/7b (#1169f): lower a yield expression-statement. The yielded
 * value is pushed onto the generator's `__gen_buffer` Wasm-local slot
 * via `gen.push`, which the lowerer expands to a typed `__gen_push_*`
 * host call dispatched on the value's IrType (f64 → push_f64,
 * i32 → push_i32, otherwise externref → push_ref).
 *
 * Slice 7b adds three extensions:
 *   - **Bare `yield;`** — emits a null-externref const + `gen.push`,
 *     matching legacy's "yield with no value" semantics (every
 *     consumer sees `IteratorResult { value: undefined, done: false }`
 *     for that step).
 *   - **`yield <non-numeric>`** — strings, booleans-as-i32 stay native;
 *     ref/object/class/closure values coerce to externref via
 *     `coerce.to_externref` (the `extern.convert_any` Wasm op), then
 *     flow through `__gen_push_ref(buf, externref)`.
 *   - **`yield* <iterable>`** — coerces the iterable to externref and
 *     emits `gen.yieldStar`, which lowers to
 *     `__gen_yield_star(buf, iterable)`. The host iterator-protocol
 *     drains every value from the inner iterable into the outer
 *     buffer (see `runtime.ts:2999`).
 *
 * Defensive: throws if the enclosing function isn't a generator. The
 * selector should have rejected the function in that case, but a
 * defensive check here surfaces selector regressions as a clean
 * fall-back to legacy rather than malformed Wasm.
 */
function lowerYield(expr: ts.YieldExpression, cx: LowerCtx): void {
  if (cx.funcKind !== "generator") {
    throw new Error(`ir/from-ast: yield outside generator function in ${cx.funcName}`);
  }

  // ---------------------------------------------------------------
  // `yield* <iterable>` — slice 7b.
  // ---------------------------------------------------------------
  if (expr.asteriskToken) {
    if (!expr.expression) {
      // TS parser enforces this; keep as defense-in-depth.
      throw new Error(`ir/from-ast: yield* requires an iterable in ${cx.funcName}`);
    }
    // Lower the iterable with an externref hint; the iterable's
    // actual IrType might be vec/string/object/externref. Coerce to
    // externref via the slice-6-part-3 helper so the host
    // `__gen_yield_star(externref, externref)` import sees the
    // right Wasm value type.
    const inner = lowerExpr(expr.expression, cx, irVal({ kind: "externref" }));
    const innerExt = coerceYieldValueToExternref(inner, cx);
    cx.builder.emitGenYieldStar(innerExt);
    return;
  }

  // ---------------------------------------------------------------
  // Bare `yield;` (no value) — slice 7b.
  // ---------------------------------------------------------------
  if (!expr.expression) {
    // Materialize a null externref and push as ref. Legacy emits
    // the same shape (`__gen_push_ref(buf, ref.null.extern)`) when
    // a `yield;` statement appears in a generator body.
    const nullExt = cx.builder.emitConst(
      { kind: "null", ty: irVal({ kind: "externref" }) },
      irVal({ kind: "externref" }),
    );
    cx.builder.emitGenPush(nullExt);
    return;
  }

  // ---------------------------------------------------------------
  // `yield <expr>` — slice 7a (numeric) and 7b (any Phase-1 type).
  // ---------------------------------------------------------------
  // Lower with an externref hint as a fallback shape; the IR type
  // recovered via `typeOf` drives the dispatch below. For numeric
  // and bool yields the lowerer's downstream typing keeps them as
  // f64/i32 — `lowerExpr`'s `hint` is advisory, not authoritative.
  const value = lowerExpr(expr.expression, cx, irVal({ kind: "externref" }));
  const valueType = cx.builder.typeOf(value);
  const valTy = asVal(valueType);
  if (valTy?.kind === "f64" || valTy?.kind === "i32") {
    // Native primitive yield — `gen.push` lowerer dispatches to
    // `__gen_push_f64` / `__gen_push_i32` directly.
    cx.builder.emitGenPush(value);
    return;
  }
  // Reference-shaped yield — coerce to externref so the lowerer's
  // `__gen_push_ref(buf, externref)` arm sees the right Wasm type.
  const valueExt = coerceYieldValueToExternref(value, cx);
  cx.builder.emitGenPush(valueExt);
}

/**
 * Slice 7b helper: coerce a yielded SSA value to externref for the
 * `__gen_push_ref` / `__gen_yield_star` arms. Skips the coerce when
 * the value's underlying Wasm valtype is ALREADY externref —
 * emitting `extern.convert_any` on an already-externref operand is
 * actually a Wasm validation error (the op expects an `anyref`
 * subtype, and `externref` is NOT a subtype of `anyref`).
 *
 * Cases that skip the coerce:
 *   - `IrType.val` with `val.kind === "externref"` — directly externref.
 *   - `IrType.string` in HOST-strings mode — `resolveString()` returns
 *     externref for the host backend (the wasm:js-string imports take
 *     externref), so the value flowing through is already externref.
 *
 * Cases that DO coerce:
 *   - `IrType.string` in NATIVE-strings mode — value is `(ref $AnyString)`,
 *     a struct ref subtype of anyref, so `extern.convert_any` re-tags it.
 *   - `IrType.val` with `val.kind === "ref"` / `"ref_null"` —
 *     struct/array refs are anyref subtypes; coerce is valid.
 *   - `IrType.object` / `class` / `closure` — all backed by struct refs,
 *     anyref subtypes; coerce is valid.
 *
 * Reuses `coerce.to_externref` (#1182) so the generator path and the
 * iter-host for-of path share one IR primitive — the lowerer emits
 * `extern.convert_any` for both.
 */
function coerceYieldValueToExternref(value: IrValueId, cx: LowerCtx): IrValueId {
  const t = cx.builder.typeOf(value);
  if (t.kind === "val" && t.val.kind === "externref") {
    return value;
  }
  // Host-strings mode: `IrType.string` flows as externref through Wasm.
  // Skip the coerce so we don't emit a validation-rejected
  // `extern.convert_any` over a global.get of externref-typed string
  // global. Resolver presence follows the #1185 pattern (see
  // `LowerCtx.resolver` doc) — when absent, treat as host-strings.
  if (t.kind === "string" && !cx.resolver?.nativeStrings?.()) {
    return value;
  }
  return cx.builder.emitCoerceToExternref(value);
}

/**
 * Lower a `for (const|let <id> of <expr>) <body>` statement using the
 * vec fast path. The iterable expression must lower to an IR value
 * whose ValType is `(ref $vec_*)` or `(ref_null $vec_*)`. The vec's
 * struct shape (`{ length: i32, data: (ref $arr_<elem>) }`) is read at
 * lowering time via `inferVecElementValType` so we can pre-allocate
 * the element slot with the right ValType.
 */
function lowerForOfStatement(stmt: ts.ForOfStatement, cx: LowerCtx): void {
  // 1. Lower the iterable. Pass an externref hint — the actual IR type
  //    is inferred from the lowered value.
  const iterableV = lowerExpr(stmt.expression, cx, irVal({ kind: "externref" }));
  const iterableT = cx.builder.typeOf(iterableV);

  // 2. Resolve the loop-variable name. The selector enforces a single
  //    Identifier-named decl in `(const|let)` form. Shared between vec
  //    and iter-host arms.
  const init = stmt.initializer;
  if (!ts.isVariableDeclarationList(init) || init.declarations.length !== 1) {
    throw new Error(`ir/from-ast: for-of init shape unexpected (${cx.funcName})`);
  }
  const decl = init.declarations[0]!;
  if (!ts.isIdentifier(decl.name)) {
    throw new Error(`ir/from-ast: for-of destructuring init not in slice 6 (${cx.funcName})`);
  }
  const loopVarName = decl.name.text;

  // 3. Strategy dispatch.
  //
  //   - `(val) ref|ref_null`        → vec path (slice 6 part 2 — #1181).
  //                                    The lowerer's resolveVec validates
  //                                    the struct's `{ length, data }`
  //                                    shape; if it isn't a vec, lowering
  //                                    throws and the function falls back
  //                                    to legacy.
  //   - `string` (native mode)      → string fast path (slice 6 part 4 — #1183).
  //                                    Counter loop with `__str_charAt`.
  //   - `string` (host mode)         → fall through to iter-host. The
  //                                    string IR value is already
  //                                    externref-backed in host mode, so
  //                                    no coercion is needed.
  //   - `(val) externref`           → iter-host (slice 6 part 3 — #1182).
  //   - `class` / `object`           → iter-host (with extern.convert_any
  //                                    coercion).
  //   - anything else                → throw, fall back to legacy.
  const valTy = asVal(iterableT);
  if (valTy && (valTy.kind === "ref" || valTy.kind === "ref_null")) {
    lowerForOfVec(stmt, cx, iterableV, valTy, loopVarName);
    return;
  }
  if (iterableT.kind === "string") {
    if (cx.resolver?.nativeStrings?.()) {
      lowerForOfString(stmt, cx, iterableV, loopVarName);
      return;
    }
    // Host-strings mode: fall through to iter-host. The string's
    // underlying ValType is already externref, so no coercion is
    // needed — the iter-host arm passes `iterableV` straight to
    // `__iterator`. We bind the loop variable as externref (host
    // strings only have host-side string semantics; the iter-host
    // element is opaque externref by design).
    lowerForOfIterFromExternrefValue(stmt, cx, iterableV, loopVarName, /* alreadyExternref */ true);
    return;
  }

  // Iter-host arm: externref / class / object iterables.
  const isIterHostEligible = valTy?.kind === "externref" || iterableT.kind === "class" || iterableT.kind === "object";
  if (!isIterHostEligible) {
    throw new Error(
      `ir/from-ast: for-of iterable type ${describeIrType(iterableT)} not supported in slice 6 (${cx.funcName})`,
    );
  }
  lowerForOfIterFromExternrefValue(stmt, cx, iterableV, loopVarName, valTy?.kind === "externref");
}

/**
 * Slice 6 part 3 (#1182) iter-host emit helper, factored out of
 * `lowerForOfStatement` so the string-arm host-strings fall-through can
 * reuse it. `alreadyExternref` skips the `extern.convert_any` coercion
 * when the input value is already externref-typed at the Wasm level
 * (true for `(val) externref` and for `IrType.string` in host mode).
 */
function lowerForOfIterFromExternrefValue(
  stmt: ts.ForOfStatement,
  cx: LowerCtx,
  iterableV: IrValueId,
  loopVarName: string,
  alreadyExternref: boolean,
): void {
  let iterableExt = iterableV;
  if (!alreadyExternref) {
    iterableExt = cx.builder.emitCoerceToExternref(iterableV);
  }

  const iterSlot = cx.builder.declareSlot("__forof_iter", { kind: "externref" });
  const resultSlot = cx.builder.declareSlot("__forof_result", { kind: "externref" });
  const elementSlot = cx.builder.declareSlot("__forof_elem", { kind: "externref" });

  const elemIrT: IrType = irVal({ kind: "externref" });
  const bodyScope = new Map(cx.scope);
  bodyScope.set(loopVarName, { kind: "slot", slotIndex: elementSlot, type: elemIrT });
  const bodyCx: LowerCtx = { ...cx, scope: bodyScope };

  const body = cx.builder.collectBodyInstrs(() => {
    lowerStmt(stmt.statement, bodyCx);
  });

  cx.builder.emitForOfIter({
    iterable: iterableExt,
    iterSlot,
    resultSlot,
    elementSlot,
    body,
  });
}

/**
 * Slice 6 part 4 (#1183) — native-strings string for-of. Iterates code
 * units via `__str_charAt(str, i)`. The element IR type is `string`
 * (single-char string ref); body code can compose with slice-1 string
 * ops. The slot ValType is `(ref $AnyString)`, supplied by
 * `nativeStringRefValType` (the lowering-time resolver shape — we
 * synthesize the same shape here so from-ast doesn't need a resolver
 * thread-through). The lowerer cross-checks the slot type against
 * `resolver.resolveString()` at emit time.
 */
function lowerForOfString(stmt: ts.ForOfStatement, cx: LowerCtx, strV: IrValueId, loopVarName: string): void {
  // Native-strings mode requires the resolver's `resolveString()` to
  // produce a `(ref $AnyString)` ValType. If the resolver is absent,
  // the function falls back to legacy via the throw — same outcome
  // as before #1185, just wired through one indirection.
  const strRef = cx.resolver?.resolveString?.();
  if (!strRef || strRef.kind !== "ref") {
    throw new Error(`ir/from-ast: native-strings for-of needs resolver.resolveString() (${cx.funcName})`);
  }

  const counterSlot = cx.builder.declareSlot("__forof_si", { kind: "i32" });
  const lengthSlot = cx.builder.declareSlot("__forof_slen", { kind: "i32" });
  const strSlot = cx.builder.declareSlot("__forof_str", strRef);
  const elementSlot = cx.builder.declareSlot("__forof_selem", strRef);

  // The loop variable is bound as a slot of `(ref $AnyString)`. In
  // native-strings mode the `IrType.string` lowering also produces
  // `(ref $AnyString)`, so as a Wasm value the slot read result and a
  // string-typed SSA value are interchangeable.
  //
  // Slice 6 part 4 refactor (#1185): we tag the binding with
  // `asType: IrType.string` so identifier reads of the loop var
  // produce SSA values typed `IrType.string` rather than
  // `irVal((ref $AnyString))`. This lets body code compose with
  // slice-1 string ops (`c + "world"`, `c.length`, etc.). The
  // underlying Wasm op is unchanged — `slot.read` against the
  // externref-or-ref slot — only the SSA type tag is rewritten.
  const elemIrT: IrType = irVal(strRef);
  const bodyScope = new Map(cx.scope);
  bodyScope.set(loopVarName, {
    kind: "slot",
    slotIndex: elementSlot,
    type: elemIrT,
    asType: { kind: "string" },
  });
  const bodyCx: LowerCtx = { ...cx, scope: bodyScope };

  const body = cx.builder.collectBodyInstrs(() => {
    lowerStmt(stmt.statement, bodyCx);
  });

  cx.builder.emitForOfString({
    str: strV,
    counterSlot,
    lengthSlot,
    strSlot,
    elementSlot,
    body,
  });
}

/**
 * Slice 6 part 2 (#1181) vec fast-path — extracted into a helper so
 * `lowerForOfStatement` can dispatch between vec and iter-host arms.
 */
function lowerForOfVec(
  stmt: ts.ForOfStatement,
  cx: LowerCtx,
  iterableV: IrValueId,
  valTy: ValType,
  loopVarName: string,
): void {
  // Slice 6 part 4 refactor (#1185): ask the resolver for the vec
  // shape rather than hard-coding `f64` element / `vecTypeIdx - 1`
  // data-array assumptions. The resolver inspects the actual
  // registered struct fields and returns the correct element
  // ValType + array typeIdx; we synthesize the data-field ValType
  // (a non-null ref to the array type) from the latter.
  //
  // Fall back to the legacy heuristic only if the resolver is
  // absent (older callers / tests) — same behavior as before #1185.
  let elemValType: ValType | null = null;
  let dataValType: ValType | null = null;
  const vec = cx.resolver?.resolveVec?.(valTy);
  if (vec) {
    elemValType = vec.elementValType;
    dataValType = { kind: "ref", typeIdx: vec.arrayTypeIdx };
  } else {
    elemValType = inferVecElementValTypeFromContext(valTy, cx);
    dataValType = inferVecDataValTypeFromContext(valTy, cx);
  }
  if (!elemValType) {
    throw new Error(`ir/from-ast: for-of iterable's IR type is not a recognisable vec in ${cx.funcName}`);
  }
  const elemIrT = irVal(elemValType);

  if (!dataValType) {
    throw new Error(`ir/from-ast: for-of vec has unexpected data field shape (${cx.funcName})`);
  }
  const counterSlot = cx.builder.declareSlot("__forof_i", { kind: "i32" });
  const lengthSlot = cx.builder.declareSlot("__forof_len", { kind: "i32" });
  const vecSlot = cx.builder.declareSlot("__forof_vec", valTy);
  const dataSlot = cx.builder.declareSlot("__forof_data", dataValType);
  const elementSlot = cx.builder.declareSlot("__forof_elem", elemValType);

  const bodyScope = new Map(cx.scope);
  bodyScope.set(loopVarName, { kind: "slot", slotIndex: elementSlot, type: elemIrT });
  const bodyCx: LowerCtx = { ...cx, scope: bodyScope };

  const body = cx.builder.collectBodyInstrs(() => {
    lowerStmt(stmt.statement, bodyCx);
  });

  cx.builder.emitForOfVec({
    vec: iterableV,
    elementType: elemIrT,
    counterSlot,
    lengthSlot,
    vecSlot,
    dataSlot,
    elementSlot,
    body,
  });
}

/**
 * Recover the element ValType of a vec from its `(ref|ref_null) $vec_*`
 * ValType by walking the legacy type registry (same lookup the
 * resolver's `resolveVec` performs at lowering time, but inlined here
 * because the from-ast layer doesn't have direct access to the
 * resolver). Returns `null` if the struct shape isn't recognisable as
 * a vec.
 *
 * The IR builder doesn't have access to `ctx.mod.types` directly —
 * we'd need to thread the resolver through `LowerCtx` for that. For
 * slice-6 part 2 we reuse the typeOf+structInspect mechanism the
 * resolver itself uses, but inline. Future cleanup can hoist this
 * into the resolver and pass it through `LowerCtx`.
 */
function inferVecElementValTypeFromContext(_valTy: ValType, _cx: LowerCtx): ValType | null {
  // Slice 6 part 2 deferred design: the legacy vec IS always shaped as
  // `{ length: i32, data: (ref $arr_<elem>) }` for f64-element vecs
  // (the only variety the IR-claimable Array<number> path produces in
  // slice 6). The lowerer's resolveVec verifies the shape; from-ast
  // just needs the element ValType to size the element slot. For
  // slice-6's narrow vec scope we hardcode `f64` — the resolver will
  // throw at lowering time if the actual struct shape differs.
  //
  // A cleaner design (deferred to a follow-up) threads the resolver
  // through `LowerCtx` so this function can call `resolveVec(valTy)`
  // and read `elementValType` off the result. The current shape works
  // for the slice-6 vec test cases and matches the spec's deferred-
  // design stance.
  return { kind: "f64" };
}

/**
 * Recover the vec's data-array ValType (the `data` field type, a
 * non-null `(ref $arr_<elem>)`). Same caveats as
 * `inferVecElementValTypeFromContext` — slice-6 hardcodes the
 * data-field as `(ref $arr_f64)` since that's what the legacy
 * `getOrRegisterVecType("f64", ...)` produces and matches every
 * IR-claimable Array<number> param.
 */
function inferVecDataValTypeFromContext(valTy: ValType, _cx: LowerCtx): ValType | null {
  // The data-array typeIdx for a vec at typeIdx N is N - 1 in the
  // legacy registry (the array type is registered first, then the
  // wrapping vec struct). This is brittle but matches the layout the
  // legacy `getOrRegisterArrayType` + `getOrRegisterVecType` produce.
  // Revisit when threading the resolver through LowerCtx (see the
  // note on `inferVecElementValTypeFromContext`).
  if (valTy.kind !== "ref" && valTy.kind !== "ref_null") return null;
  const vecTypeIdx = (valTy as { typeIdx: number }).typeIdx;
  // Default: data is always at vecTypeIdx - 1 in the legacy layout.
  return { kind: "ref", typeIdx: vecTypeIdx - 1 };
}

/**
 * Slice 6 part 2 (#1181): body-statement dispatcher. Mirrors the
 * `isPhase1BodyStatement` selector arm in `src/ir/select.ts` —
 * accepts Block (recurses), VariableStatement, identifier-LHS /
 * property-LHS / compound-assignment ExpressionStatements, bare
 * CallExpression, and nested ForOfStatement.
 *
 * No fall-through if/else, no nested closures, no early-return —
 * those are statement-list / tail-context features that don't make
 * sense inside a non-terminating loop body.
 */
function lowerStmt(stmt: ts.Statement, cx: LowerCtx): void {
  if (ts.isBlock(stmt)) {
    const childCx: LowerCtx = { ...cx, scope: new Map(cx.scope) };
    for (const s of stmt.statements) {
      lowerStmt(s, childCx);
    }
    return;
  }
  if (ts.isVariableStatement(stmt)) {
    lowerVarDecl(stmt, cx);
    return;
  }
  if (ts.isExpressionStatement(stmt)) {
    if (ts.isCallExpression(stmt.expression)) {
      void lowerExpr(stmt.expression, cx, irVal({ kind: "f64" }));
      return;
    }
    // Slice 7a (#1169f): `yield <expr>;` inside a for-of body. The
    // selector accepts this shape; the lowerer enforces the enclosing
    // function is a generator via `lowerYield`.
    if (ts.isYieldExpression(stmt.expression)) {
      lowerYield(stmt.expression, cx);
      return;
    }
    if (ts.isBinaryExpression(stmt.expression)) {
      const op = stmt.expression.operatorToken.kind;
      // Plain assignment `<id> = <expr>` — id MUST resolve to a `slot`
      // binding (mutation pre-pass should have detected it). For
      // property assignment, dispatch to `lowerPropertyAssignment`
      // (the slice-4 helper).
      if (op === ts.SyntaxKind.EqualsToken) {
        if (ts.isIdentifier(stmt.expression.left)) {
          lowerIdentifierAssignment(stmt.expression.left, stmt.expression.right, cx);
          return;
        }
        if (ts.isPropertyAccessExpression(stmt.expression.left)) {
          lowerPropertyAssignment(stmt.expression, cx);
          return;
        }
      }
      // Compound assignment `<id> <op>= <expr>` — desugar to
      // `<id> = <id> <binop> <expr>`. The binop maps from the
      // compound-assignment token kind. This keeps the lowering
      // straightforward; the optimizer can fold redundant reads later.
      if (
        op === ts.SyntaxKind.PlusEqualsToken ||
        op === ts.SyntaxKind.MinusEqualsToken ||
        op === ts.SyntaxKind.AsteriskEqualsToken ||
        op === ts.SyntaxKind.SlashEqualsToken
      ) {
        if (ts.isIdentifier(stmt.expression.left)) {
          lowerCompoundAssignment(stmt.expression.left, op, stmt.expression.right, cx);
          return;
        }
      }
    }
    throw new Error(`ir/from-ast: unsupported body ExpressionStatement shape in ${cx.funcName}`);
  }
  if (ts.isForOfStatement(stmt)) {
    lowerForOfStatement(stmt, cx);
    return;
  }
  throw new Error(`ir/from-ast: unsupported body statement ${ts.SyntaxKind[stmt.kind]} in ${cx.funcName}`);
}

/**
 * Lower `<id> = <expr>` where `<id>` is a slot-bound identifier.
 * Throws if the binding isn't a slot — mutation of a `local` would
 * silently produce wrong results (the reassignment wouldn't be
 * observable through the existing SSA value), so the mutation
 * pre-pass should have flagged the name.
 */
function lowerIdentifierAssignment(id: ts.Identifier, rhs: ts.Expression, cx: LowerCtx): void {
  const binding = cx.scope.get(id.text);
  if (!binding) {
    throw new Error(`ir/from-ast: assignment to undeclared identifier "${id.text}" in ${cx.funcName}`);
  }
  if (binding.kind !== "slot") {
    throw new Error(
      `ir/from-ast: assignment to non-slot binding "${id.text}" — mutation pre-pass should have detected it (${cx.funcName})`,
    );
  }
  // Slice 6 part 4 refactor (#1185): when the binding has an asType
  // widening, the IR type the body sees is `asType`, not the
  // underlying slot ValType. Use `asType` for the lowering hint and
  // type check; the slot.write itself accepts any value of the
  // underlying ValType, which `asType` agrees with at the Wasm
  // level (the asType invariant guarantees this).
  const logicalType = binding.asType ?? binding.type;
  const newValue = lowerExpr(rhs, cx, logicalType);
  const newType = cx.builder.typeOf(newValue);
  if (!irTypeEquals(newType, logicalType)) {
    throw new Error(
      `ir/from-ast: assignment to "${id.text}" (${describeIrType(logicalType)}) got ${describeIrType(newType)} in ${cx.funcName}`,
    );
  }
  cx.builder.emitSlotWrite(binding.slotIndex, newValue);
}

/**
 * Lower `<id> <op>= <expr>` by desugaring to `<id> = <id> <binop> <expr>`.
 * The binop is the arithmetic/comparison operator implied by the
 * compound-assignment token (e.g. `+=` → `f64.add` for f64 operands).
 * Only handles f64 operands in slice 6 — i32 (boolean) compound
 * assignment is rare and deferred.
 */
function lowerCompoundAssignment(id: ts.Identifier, compoundOp: ts.SyntaxKind, rhs: ts.Expression, cx: LowerCtx): void {
  const binding = cx.scope.get(id.text);
  if (!binding) {
    throw new Error(`ir/from-ast: compound assign to undeclared identifier "${id.text}" in ${cx.funcName}`);
  }
  if (binding.kind !== "slot") {
    throw new Error(
      `ir/from-ast: compound assign to non-slot binding "${id.text}" — mutation pre-pass should have detected it (${cx.funcName})`,
    );
  }
  const slotValType = asVal(binding.type);
  if (!slotValType || slotValType.kind !== "f64") {
    throw new Error(
      `ir/from-ast: compound assign to non-f64 slot "${id.text}" (${describeIrType(binding.type)}) not in slice 6 (${cx.funcName})`,
    );
  }

  // Desugar: read the slot, lower the RHS, apply the binop, write back.
  const lhs = cx.builder.emitSlotRead(binding.slotIndex);
  const rhsValue = lowerExpr(rhs, cx, binding.type);
  const rhsType = cx.builder.typeOf(rhsValue);
  if (asVal(rhsType)?.kind !== "f64") {
    throw new Error(`ir/from-ast: compound assign RHS must be f64 (got ${describeIrType(rhsType)}) in ${cx.funcName}`);
  }

  let binop: IrBinop;
  switch (compoundOp) {
    case ts.SyntaxKind.PlusEqualsToken:
      binop = "f64.add";
      break;
    case ts.SyntaxKind.MinusEqualsToken:
      binop = "f64.sub";
      break;
    case ts.SyntaxKind.AsteriskEqualsToken:
      binop = "f64.mul";
      break;
    case ts.SyntaxKind.SlashEqualsToken:
      binop = "f64.div";
      break;
    default:
      throw new Error(`ir/from-ast: unsupported compound assign op ${ts.SyntaxKind[compoundOp]} in ${cx.funcName}`);
  }
  const result = cx.builder.emitBinary(binop, lhs, rhsValue, irVal({ kind: "f64" }));
  cx.builder.emitSlotWrite(binding.slotIndex, result);
}

function lowerConditional(expr: ts.ConditionalExpression, cx: LowerCtx): IrValueId {
  const cond = lowerExpr(expr.condition, cx, irVal({ kind: "i32" }));
  const condType = cx.builder.typeOf(cond);
  if (asVal(condType)?.kind !== "i32") {
    throw new Error(`ir/from-ast: ternary condition must be bool in ${cx.funcName}`);
  }
  const whenTrue = lowerExpr(expr.whenTrue, cx, irVal({ kind: "f64" }));
  const whenFalse = lowerExpr(expr.whenFalse, cx, irVal({ kind: "f64" }));
  const ttype = cx.builder.typeOf(whenTrue);
  const ftype = cx.builder.typeOf(whenFalse);
  const tVal = asVal(ttype);
  const fVal = asVal(ftype);
  if (!tVal || !fVal || tVal.kind !== fVal.kind) {
    throw new Error(
      `ir/from-ast: ternary branches have different types (${describeIrType(ttype)} vs ${describeIrType(ftype)}) in ${cx.funcName}`,
    );
  }
  return cx.builder.emitSelect(cond, whenTrue, whenFalse, ttype);
}

function lowerPrefixUnary(expr: ts.PrefixUnaryExpression, cx: LowerCtx): IrValueId {
  const rand = lowerExpr(expr.operand, cx, irVal({ kind: "f64" }));
  switch (expr.operator) {
    case ts.SyntaxKind.MinusToken: {
      const randType = typeOfValue(rand, cx);
      if (asVal(randType)?.kind !== "f64") {
        throw new Error(`ir/from-ast: unary '-' expects number in ${cx.funcName}`);
      }
      return cx.builder.emitUnary("f64.neg", rand, irVal({ kind: "f64" }));
    }
    case ts.SyntaxKind.PlusToken: {
      const randType = typeOfValue(rand, cx);
      if (asVal(randType)?.kind !== "f64") {
        throw new Error(`ir/from-ast: unary '+' expects number in ${cx.funcName}`);
      }
      return rand;
    }
    case ts.SyntaxKind.ExclamationToken: {
      const randType = typeOfValue(rand, cx);
      if (asVal(randType)?.kind !== "i32") {
        throw new Error(`ir/from-ast: unary '!' expects bool in ${cx.funcName}`);
      }
      return cx.builder.emitUnary("i32.eqz", rand, irVal({ kind: "i32" }));
    }
    default:
      throw new Error(`ir/from-ast: unsupported prefix operator ${ts.SyntaxKind[expr.operator]} in ${cx.funcName}`);
  }
}

function lowerBinary(expr: ts.BinaryExpression, cx: LowerCtx): IrValueId {
  const op = expr.operatorToken.kind;

  // === / !== / == / != with a `null` literal: slice 1 has no nullable IR
  // types yet, so every operand we can lower trivially evaluates to false
  // for === null / true for !== null. Try this fold first; it short-
  // circuits the standard f64-hint lowering below (which would otherwise
  // recurse into a bare NullKeyword and throw).
  const nullFold = tryFoldNullCompare(expr, op, cx);
  if (nullFold !== null) return nullFold;

  const lhs = lowerExpr(expr.left, cx, irVal({ kind: "f64" }));
  const rhs = lowerExpr(expr.right, cx, irVal({ kind: "f64" }));
  const lt = typeOfValue(lhs, cx);
  const rt = typeOfValue(rhs, cx);

  // String operand path (slice 1, #1169a) — `+`, `===`, `!==`, `==`, `!=`.
  // Any other operator with a string operand throws so the function falls
  // back to legacy.
  if (lt.kind === "string" || rt.kind === "string") {
    if (lt.kind !== "string" || rt.kind !== "string") {
      throw new Error(
        `ir/from-ast: mixed string/non-string operand for '${ts.tokenToString(op)}' is not in slice 1 (${cx.funcName})`,
      );
    }
    switch (op) {
      case ts.SyntaxKind.PlusToken:
        return cx.builder.emitStringConcat(lhs, rhs);
      case ts.SyntaxKind.EqualsEqualsEqualsToken:
      case ts.SyntaxKind.EqualsEqualsToken:
        return cx.builder.emitStringEq(lhs, rhs, false);
      case ts.SyntaxKind.ExclamationEqualsEqualsToken:
      case ts.SyntaxKind.ExclamationEqualsToken:
        return cx.builder.emitStringEq(lhs, rhs, true);
      default:
        throw new Error(`ir/from-ast: string operator '${ts.tokenToString(op)}' not in slice 1 (${cx.funcName})`);
    }
  }

  const ltVal = asVal(lt);
  const rtVal = asVal(rt);
  if (!ltVal || !rtVal || ltVal.kind !== rtVal.kind) {
    throw new Error(
      `ir/from-ast: Phase 1 requires matching operand types for '${ts.tokenToString(op)}' in ${cx.funcName}`,
    );
  }

  const isF64 = ltVal.kind === "f64";
  const isI32 = ltVal.kind === "i32";

  let binop: IrBinop;
  let resultType: IrType;

  switch (op) {
    case ts.SyntaxKind.PlusToken:
      requireF64(isF64, "+", cx.funcName);
      binop = "f64.add";
      resultType = irVal({ kind: "f64" });
      break;
    case ts.SyntaxKind.MinusToken:
      requireF64(isF64, "-", cx.funcName);
      binop = "f64.sub";
      resultType = irVal({ kind: "f64" });
      break;
    case ts.SyntaxKind.AsteriskToken:
      requireF64(isF64, "*", cx.funcName);
      binop = "f64.mul";
      resultType = irVal({ kind: "f64" });
      break;
    case ts.SyntaxKind.SlashToken:
      requireF64(isF64, "/", cx.funcName);
      binop = "f64.div";
      resultType = irVal({ kind: "f64" });
      break;
    case ts.SyntaxKind.LessThanToken:
      requireF64(isF64, "<", cx.funcName);
      binop = "f64.lt";
      resultType = irVal({ kind: "i32" });
      break;
    case ts.SyntaxKind.LessThanEqualsToken:
      requireF64(isF64, "<=", cx.funcName);
      binop = "f64.le";
      resultType = irVal({ kind: "i32" });
      break;
    case ts.SyntaxKind.GreaterThanToken:
      requireF64(isF64, ">", cx.funcName);
      binop = "f64.gt";
      resultType = irVal({ kind: "i32" });
      break;
    case ts.SyntaxKind.GreaterThanEqualsToken:
      requireF64(isF64, ">=", cx.funcName);
      binop = "f64.ge";
      resultType = irVal({ kind: "i32" });
      break;
    case ts.SyntaxKind.EqualsEqualsEqualsToken:
    case ts.SyntaxKind.EqualsEqualsToken:
      binop = isF64 ? "f64.eq" : "i32.eq";
      resultType = irVal({ kind: "i32" });
      break;
    case ts.SyntaxKind.ExclamationEqualsEqualsToken:
    case ts.SyntaxKind.ExclamationEqualsToken:
      binop = isF64 ? "f64.ne" : "i32.ne";
      resultType = irVal({ kind: "i32" });
      break;
    case ts.SyntaxKind.AmpersandAmpersandToken:
      requireI32(isI32, "&&", cx.funcName);
      binop = "i32.and";
      resultType = irVal({ kind: "i32" });
      break;
    case ts.SyntaxKind.BarBarToken:
      requireI32(isI32, "||", cx.funcName);
      binop = "i32.or";
      resultType = irVal({ kind: "i32" });
      break;
    default:
      throw new Error(`ir/from-ast: unsupported binary operator ${ts.tokenToString(op)} in ${cx.funcName}`);
  }

  return cx.builder.emitBinary(binop, lhs, rhs, resultType);
}

function requireF64(isF64: boolean, op: string, fn: string): void {
  if (!isF64) throw new Error(`ir/from-ast: operator '${op}' requires number operands in ${fn}`);
}

function requireI32(isI32: boolean, op: string, fn: string): void {
  if (!isI32) throw new Error(`ir/from-ast: operator '${op}' requires bool operands in ${fn}`);
}

function typeOfValue(v: IrValueId, cx: LowerCtx): IrType {
  return cx.builder.typeOf(v);
}

/**
 * Compile-time fold for `expr === null` / `expr !== null` / `expr == null` /
 * `expr != null` when the non-null operand has a non-nullable IR type.
 *
 * Slice 1 (#1169a) has no nullable IR types yet (no `nullable union`,
 * no `boxed-null`), so any operand we can lower is provably non-null:
 *   - `expr === null`  → `false`
 *   - `expr !== null`  → `true`
 *
 * The non-null operand IS lowered (rather than skipped) so its side
 * effects are preserved; the IR DCE pass strips the unused value when
 * the producing instructions are pure. If the operand's IR type is
 * `boxed` (deferred to a later slice), we return `null` so the fold
 * doesn't fire and the caller's standard binary path throws cleanly,
 * letting the function fall back to legacy.
 *
 * Returns `null` when this isn't a `null`-compare (so the caller
 * proceeds with the normal lowering).
 */
function tryFoldNullCompare(expr: ts.BinaryExpression, op: ts.SyntaxKind, cx: LowerCtx): IrValueId | null {
  const isEq = op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken;
  const isNeq = op === ts.SyntaxKind.ExclamationEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken;
  if (!isEq && !isNeq) return null;

  let other: ts.Expression | null = null;
  if (expr.left.kind === ts.SyntaxKind.NullKeyword) other = expr.right;
  else if (expr.right.kind === ts.SyntaxKind.NullKeyword) other = expr.left;
  else return null;

  // Lower the non-null side to learn its IrType AND keep any side effects
  // emitted (the IR DCE pass drops the unused result if the producing
  // instructions are pure).
  const v = lowerExpr(other, cx, irVal({ kind: "f64" }));
  const otherType = cx.builder.typeOf(v);

  // Slice 1 only knows non-nullable types: `val<...>`, `string`, and
  // unions whose members are non-null (V1 unions only carry f64/i32).
  // `boxed` is deferred; bail so the caller errors cleanly.
  if (otherType.kind === "boxed") return null;
  // Slice 10 (#1169i): extern-class values are externref-shaped at
  // the Wasm level and CAN be null at runtime — `RegExp.exec()` and
  // similar host imports are documented to return `externref|null`.
  // Bail so the caller falls back to legacy, which has a runtime
  // `ref.is_null` check on the receiver. (TODO follow-up: emit
  // `ref.is_null` directly from the IR.)
  if (otherType.kind === "extern") return null;
  // Slice 10 (#1169i): a `val { externref }` operand is similarly
  // nullable. Functions that compare externref-typed values against
  // null (e.g. through extern.call results assigned to a local) need
  // a runtime null check, not a static fold.
  const otherVal = asVal(otherType);
  if (otherVal && (otherVal.kind === "externref" || otherVal.kind === "ref_null")) {
    return null;
  }

  return cx.builder.emitConst({ kind: "bool", value: isNeq }, irVal({ kind: "i32" }));
}

/** Result-type hints aren't used in Phase 1 (we always know from the op). */
export type _Unused = IrUnop;

// ---------------------------------------------------------------------------
// Closure / nested-function lowering (#1169c — IR Phase 4 Slice 3)
// ---------------------------------------------------------------------------

/**
 * Lower an arrow function or function expression as an IR closure
 * value. Lifts the body to a top-level IR function (with __self as
 * param 0) and emits a `closure.new` that materialises the closure
 * struct. Returns the SSA value of the closure (its IrType is
 * `IrType.closure` with the resolved signature).
 *
 * Mutable captures: rebinds `cx.scope[capName]` to the refcell ref, so
 * subsequent outer reads/writes of `capName` route through
 * `refcell.get` / `refcell.set` automatically (see the identifier
 * handler in `lowerExpr`).
 */
function lowerClosureExpression(expr: ts.ArrowFunction | ts.FunctionExpression, cx: LowerCtx): IrValueId {
  const params: IrType[] = expr.parameters.map((p) => {
    if (!ts.isIdentifier(p.name) || !p.type) {
      throw new Error(`ir/from-ast: closure params must be Identifier-named with annotations (${cx.funcName})`);
    }
    return typeNodeToIr(p.type, `param ${p.name.text} of ${cx.funcName}.<closure>`);
  });
  if (!expr.type) {
    throw new Error(`ir/from-ast: closure must have a return type annotation (${cx.funcName})`);
  }
  const returnType = typeNodeToIr(expr.type, `return type of ${cx.funcName}.<closure>`);
  const signature: IrClosureSignature = { params, returnType };

  const captures = analyseCaptures(expr, cx);

  const liftedName = `${cx.funcName}__closure_${cx.liftedCounter.value++}`;

  // Materialize capture args. Mutable captures need a refcell; if the
  // outer doesn't already have one (a sibling closure may have built
  // one earlier), create it now and rebind the outer scope.
  const captureArgs: IrValueId[] = [];
  const captureFieldTypes: IrType[] = [];
  for (const cap of captures) {
    if (cap.mutable) {
      const innerVal = asVal(cap.type);
      if (!innerVal) {
        throw new Error(`ir/from-ast: mutable closure capture "${cap.name}" must be a primitive (${cx.funcName})`);
      }
      const fieldType: IrType = { kind: "boxed", inner: innerVal };
      captureFieldTypes.push(fieldType);
      const live = cx.scope.get(cap.name);
      if (live?.kind === "local" && live.type.kind === "boxed") {
        captureArgs.push(live.value);
      } else if (live?.kind === "local") {
        const cell = cx.builder.emitRefCellNew(live.value, innerVal);
        cx.scope.set(cap.name, { kind: "local", value: cell, type: fieldType });
        captureArgs.push(cell);
      } else {
        throw new Error(`ir/from-ast: closure mutable capture "${cap.name}" not in scope (${cx.funcName})`);
      }
    } else {
      // Read-only — pass the current scalar value. If a sibling closure
      // already upgraded the binding to a refcell, deref now so the
      // captured value is the unboxed scalar (the lifted body sees it
      // as the scalar IrType, which matches our `cap.type`).
      const live = cx.scope.get(cap.name);
      let v: IrValueId;
      if (live?.kind === "local" && live.type.kind === "boxed") {
        v = cx.builder.emitRefCellGet(live.value, live.type.inner);
      } else if (live?.kind === "local") {
        v = live.value;
      } else {
        throw new Error(`ir/from-ast: closure capture "${cap.name}" not in scope (${cx.funcName})`);
      }
      captureFieldTypes.push(cap.type);
      captureArgs.push(v);
    }
  }

  // Lift body. The lifted function takes (__self: IrType.closure,
  // ...sig.params) and reads captures via `closure.cap`.
  const lifted = liftClosureBody(liftedName, expr, signature, captures, captureFieldTypes, cx);
  cx.lifted.push(lifted);

  return cx.builder.emitClosureNew({ kind: "func", name: liftedName }, signature, captureFieldTypes, captureArgs);
}

/**
 * Lower a nested function declaration. Adds a `nestedFunc` scope
 * binding (name-only — no SSA value) and lifts the body to a
 * top-level function with prepended capture params (no __self struct).
 * Direct call: `call $lifted` with capture args first, then user args.
 */
function lowerNestedFunctionDeclaration(fn: ts.FunctionDeclaration, cx: LowerCtx): void {
  if (!fn.name || !fn.body) {
    throw new Error(`ir/from-ast: nested function without name or body in ${cx.funcName}`);
  }
  const innerName = fn.name.text;
  const params: IrType[] = fn.parameters.map((p) => {
    if (!ts.isIdentifier(p.name) || !p.type) {
      throw new Error(`ir/from-ast: nested func params must be Identifier-named with annotations (${cx.funcName})`);
    }
    return typeNodeToIr(p.type, `param ${p.name.text} of ${cx.funcName}.${innerName}`);
  });
  if (!fn.type) {
    throw new Error(`ir/from-ast: nested func must have a return type annotation (${cx.funcName})`);
  }
  const returnType = typeNodeToIr(fn.type, `return type of ${cx.funcName}.${innerName}`);
  const signature: IrClosureSignature = { params, returnType };

  const captures = analyseCaptures(fn, cx);
  const liftedName = `${cx.funcName}__nested_${innerName}_${cx.liftedCounter.value++}`;

  const lifted = liftNestedFunction(liftedName, fn, signature, captures, cx);
  cx.lifted.push(lifted);

  // Add to the OUTER scope.
  cx.scope.set(innerName, { kind: "nestedFunc", liftedName, signature, captures });
}

/**
 * Lift a nested function body to a top-level IR function. The body's
 * params are: [capture0, capture1, ..., innerParam0, ...]. Mutable
 * captures are typed `boxed<T>`; the body's identifier handler
 * dereferences them via refcell.get on read.
 */
function liftNestedFunction(
  liftedName: string,
  fn: ts.FunctionDeclaration,
  signature: IrClosureSignature,
  captures: readonly NestedCapture[],
  cx: LowerCtx,
): IrFunction {
  const builder = new IrFunctionBuilder(liftedName, [signature.returnType], false);
  const scope = new Map<string, ScopeBinding>();

  // Prepend capture params before the user's params.
  for (const cap of captures) {
    const innerVal = asVal(cap.type);
    const paramType: IrType = cap.mutable && innerVal ? { kind: "boxed", inner: innerVal } : cap.type;
    const v = builder.addParam(cap.name, paramType);
    scope.set(cap.name, { kind: "local", value: v, type: paramType });
  }
  for (let i = 0; i < fn.parameters.length; i++) {
    const p = fn.parameters[i]!;
    const name = (p.name as ts.Identifier).text;
    const t = signature.params[i]!;
    const v = builder.addParam(name, t);
    scope.set(name, { kind: "local", value: v, type: t });
  }

  builder.openBlock();

  const innerCx: LowerCtx = {
    builder,
    scope,
    funcName: liftedName,
    returnType: signature.returnType,
    calleeTypes: cx.calleeTypes,
    classShapes: cx.classShapes,
    resolver: cx.resolver,
    lifted: cx.lifted,
    liftedCounter: cx.liftedCounter,
    // Slice 6 part 2 (#1181) — nested-function bodies have their own
    // mutated-let scope (collected per-body when slice 6 extends to
    // closures). Empty here keeps the slice-3 nested-fn behavior intact.
    mutatedLets: collectMutatedLetNames(fn),
    // Slice 7a (#1169f) — nested function decls are NEVER generators
    // in slice 7a (the selector rejects `function*` nesting via
    // `isPhase1NestedFunc`).
    funcKind: "regular",
  };
  if (!fn.body) {
    throw new Error(`ir/from-ast: nested function ${innerName(fn)} has no body`);
  }
  lowerStatementList(fn.body.statements, innerCx);

  return builder.finish();
}

function innerName(fn: ts.FunctionDeclaration): string {
  return fn.name?.text ?? "<anon>";
}

/**
 * Lift a closure expression body. The lifted function has __self at
 * param 0 (typed `IrType.closure`); captures are read inside the body
 * via `closure.cap` rather than as prepended params. Mutable captures
 * land as `boxed<T>` field types so `cap` returns the refcell ref;
 * subsequent identifier reads inside the body deref via refcell.get.
 *
 * The returned IrFunction carries `closureSubtype` metadata so the
 * lowerer can emit the correct `ref.cast` on closure.cap.
 */
function liftClosureBody(
  liftedName: string,
  expr: ts.ArrowFunction | ts.FunctionExpression,
  signature: IrClosureSignature,
  captures: readonly NestedCapture[],
  captureFieldTypes: readonly IrType[],
  cx: LowerCtx,
): IrFunction {
  const builder = new IrFunctionBuilder(liftedName, [signature.returnType], false);
  const scope = new Map<string, ScopeBinding>();

  const selfType: IrType = { kind: "closure", signature };
  const selfV = builder.addParam("__self", selfType);

  for (let i = 0; i < expr.parameters.length; i++) {
    const p = expr.parameters[i]!;
    const name = (p.name as ts.Identifier).text;
    const t = signature.params[i]!;
    const v = builder.addParam(name, t);
    scope.set(name, { kind: "local", value: v, type: t });
  }

  builder.openBlock();

  // Read each capture out of __self. captureFieldTypes is parallel to
  // captures; lifted body sees captures at index 0..N-1.
  for (let i = 0; i < captures.length; i++) {
    const cap = captures[i]!;
    const fieldType = captureFieldTypes[i]!;
    const v = builder.emitClosureCap(selfV, i, fieldType);
    scope.set(cap.name, { kind: "local", value: v, type: fieldType });
  }

  const innerCx: LowerCtx = {
    builder,
    scope,
    funcName: liftedName,
    returnType: signature.returnType,
    calleeTypes: cx.calleeTypes,
    classShapes: cx.classShapes,
    resolver: cx.resolver,
    lifted: cx.lifted,
    liftedCounter: cx.liftedCounter,
    // Slice 6 part 2 (#1181) — closure-body mutated lets are scanned
    // per closure (block bodies) or empty (concise expression bodies,
    // which can't host a let declaration).
    mutatedLets:
      ts.isBlock(expr.body) && (ts.isFunctionExpression(expr) || ts.isArrowFunction(expr))
        ? collectMutatedLetNamesFromBlock(expr.body)
        : new Set<string>(),
    // Slice 7a (#1169f) — closures are never generator/async in 7a
    // (the selector rejects them in `isPhase1ClosureLiteral`).
    funcKind: "regular",
  };

  if (ts.isArrowFunction(expr) && !ts.isBlock(expr.body)) {
    // Concise body — wrap as `return <expr>`.
    const v = lowerExpr(expr.body, innerCx, signature.returnType);
    if (!irTypeEquals(builder.typeOf(v), signature.returnType)) {
      throw new Error(
        `ir/from-ast: closure body type ${describeIrType(builder.typeOf(v))} != declared return ${describeIrType(signature.returnType)} (${liftedName})`,
      );
    }
    builder.terminate({ kind: "return", values: [v] });
  } else {
    if (!ts.isBlock(expr.body)) {
      throw new Error(`ir/from-ast: closure body must be a block (got ${ts.SyntaxKind[expr.body.kind]})`);
    }
    lowerStatementList(expr.body.statements, innerCx);
  }

  return builder.finish({ signature, captureFieldTypes: [...captureFieldTypes] });
}

/**
 * Walk a closure / nested-function body and collect identifiers that
 * reference outer-scope `local` bindings. Classifies each capture as
 * mutable (the body OR the outer writes to it) or read-only.
 *
 * Outer writes are conservatively detected by walking the entire
 * outer body — any identifier-LHS write to `name` upgrades it to
 * mutable, even if the closure body itself is read-only. This is the
 * safe-and-simple approach the legacy path uses too.
 */
function analyseCaptures(
  fn: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression,
  cx: LowerCtx,
): NestedCapture[] {
  const referenced = new Set<string>();
  const written = new Set<string>();
  const ownParams = new Set<string>();
  for (const p of fn.parameters) {
    if (ts.isIdentifier(p.name)) ownParams.add(p.name.text);
  }

  const visit = (node: ts.Node): void => {
    // Don't descend into nested function-likes — they have their own
    // capture analysis run when they're lowered.
    if (node !== fn && (ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node))) {
      return;
    }
    if (ts.isIdentifier(node)) {
      referenced.add(node.text);
    }
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      if (
        op === ts.SyntaxKind.EqualsToken ||
        (op >= ts.SyntaxKind.PlusEqualsToken && op <= ts.SyntaxKind.CaretEqualsToken)
      ) {
        if (ts.isIdentifier(node.left)) written.add(node.left.text);
      }
    }
    if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
      const op = node.operator;
      if (op === ts.SyntaxKind.PlusPlusToken || op === ts.SyntaxKind.MinusMinusToken) {
        if (ts.isIdentifier(node.operand)) written.add(node.operand.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  if (fn.body) {
    if (ts.isBlock(fn.body)) {
      for (const s of fn.body.statements) visit(s);
    } else {
      visit(fn.body);
    }
  }

  const outerWrites = collectOuterWrites(fn);

  const captures: NestedCapture[] = [];
  for (const name of referenced) {
    if (ownParams.has(name)) continue;
    const binding = cx.scope.get(name);
    if (!binding) continue;
    if (binding.kind !== "local") {
      // Slice 3 doesn't yet capture closure / nested-fn bindings — that
      // would require either lifting the inner closure to a top-level
      // ref.func or adding closure VALUE fields to the capture struct.
      // Defer.
      throw new Error(
        `ir/from-ast: closure inside ${cx.funcName} captures non-local binding "${name}" — not in slice 3`,
      );
    }
    // If the local is already a refcell (a sibling closure boxed it),
    // the capture's logical type is the inner ValType — we deref on
    // read in `lowerClosureExpression`.
    const logicalType: IrType = binding.type.kind === "boxed" ? irVal(binding.type.inner) : binding.type;
    const isMutable = written.has(name) || outerWrites.has(name);
    captures.push({
      name,
      type: logicalType,
      mutable: isMutable,
      outerValue: binding.value,
    });
  }
  return captures;
}

/**
 * Slice 3 (#1169c): walk the OUTER function body to find any
 * identifier-LHS write to a name. Used to upgrade captures to mutable
 * when the outer mutates a captured variable (even if the closure
 * body itself is read-only). Conservative: any write anywhere in the
 * outer counts.
 */
function collectOuterWrites(fn: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression): Set<string> {
  const writes = new Set<string>();
  let outer: ts.Node | undefined = fn.parent;
  while (
    outer &&
    !ts.isFunctionDeclaration(outer) &&
    !ts.isFunctionExpression(outer) &&
    !ts.isArrowFunction(outer) &&
    !ts.isSourceFile(outer)
  ) {
    outer = outer.parent;
  }
  if (!outer || !("body" in outer) || !outer.body) return writes;
  const body = outer.body as ts.Node;
  const visit = (node: ts.Node): void => {
    if (node === fn) return;
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      if (
        op === ts.SyntaxKind.EqualsToken ||
        (op >= ts.SyntaxKind.PlusEqualsToken && op <= ts.SyntaxKind.CaretEqualsToken)
      ) {
        if (ts.isIdentifier(node.left)) writes.add(node.left.text);
      }
    }
    if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
      const op = node.operator;
      if (op === ts.SyntaxKind.PlusPlusToken || op === ts.SyntaxKind.MinusMinusToken) {
        if (ts.isIdentifier(node.operand)) writes.add(node.operand.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(body, visit);
  return writes;
}

// `closureSignatureEquals` is currently used elsewhere; keep an
// explicit reference here so unused-export linting doesn't flag it
// when only the lowerer consumes it.
export const _CLOSURE_SIG_EQ_REF = closureSignatureEquals;

// Reference ValType so the import isn't unused (used transitively via
// signature param types but TS may not see it).
export type _UnusedVal = ValType;
