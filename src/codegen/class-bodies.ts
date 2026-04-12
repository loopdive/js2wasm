/**
 * Class declaration collection and class body compilation.
 *
 * Extracted from codegen/index.ts (#1013).
 */
import ts from "typescript";
import { isVoidType, unwrapPromiseType } from "../checker/type-mapper.js";
import type { FieldDef, Instr, StructTypeDef, ValType } from "../ir/types.js";
import { popBody, pushBody } from "./context/bodies.js";
import { reportError } from "./context/errors.js";
import { allocLocal, deduplicateLocals } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { destructureParamArray, destructureParamObject } from "./destructuring-params.js";
import { bodyUsesArguments } from "./function-body.js";
import { cacheStringLiterals, hasAbstractModifier, hasStaticModifier, resolveWasmType } from "./index.js";
import { ensureExnTag, nextModuleGlobalIdx } from "./registry/imports.js";
import { addFuncType, getArrTypeIdxFromVec, getOrRegisterVecType } from "./registry/types.js";
import {
  coerceType,
  compileExpression,
  compileStatement,
  emitArgumentsObject,
  emitBoundsCheckedArrayGet,
  resolveComputedKeyExpression,
  valTypesMatch,
} from "./shared.js";

export function resolveClassMemberName(ctx: CodegenContext, name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isPrivateIdentifier(name)) return "__priv_" + name.text.slice(1);
  if (ts.isStringLiteral(name)) return name.text;
  if (ts.isNumericLiteral(name)) return String(Number(name.text));
  if (ts.isComputedPropertyName(name)) {
    return resolveComputedKeyExpression(ctx, name.expression);
  }
  return undefined;
}

/** Collect all function declarations and interfaces */
/** Collect a class declaration or class expression: register struct type, constructor, and methods */
export function collectClassDeclaration(
  ctx: CodegenContext,
  decl: ts.ClassDeclaration | ts.ClassExpression,
  syntheticName?: string,
): void {
  const className = syntheticName ?? decl.name!.text;
  ctx.classSet.add(className);
  ctx.classDeclarationMap.set(className, decl);

  // Register the class .name value for ES-spec compliance
  // Named class expressions keep their declared name (class X {} → name = "X")
  // Anonymous class expressions get the variable name (const C = class {} → name = "C")
  const esName = decl.name ? decl.name.text : (syntheticName ?? "");
  ctx.functionNameMap.set(className, esName);

  // For class expressions, map the TS symbol name to the synthetic class name
  // so that resolveStructName and compileNewExpression can find the struct
  if (syntheticName) {
    const tsType = ctx.checker.getTypeAtLocation(decl);
    const symbolName = tsType.getSymbol()?.name;
    if (symbolName && symbolName !== syntheticName) {
      ctx.classExprNameMap.set(symbolName, syntheticName);
    }
  }

  // Detect parent class via heritage clauses (extends)
  let parentClassName: string | undefined;
  let parentStructTypeIdx: number | undefined;
  let parentFields: FieldDef[] = [];
  if (decl.heritageClauses) {
    for (const clause of decl.heritageClauses) {
      if (clause.token === ts.SyntaxKind.ExtendsKeyword && clause.types.length > 0) {
        const baseExpr = clause.types[0]!.expression;
        if (ts.isIdentifier(baseExpr)) {
          parentClassName = baseExpr.text;
          // Guard against circular inheritance (e.g., class X extends X)
          if (parentClassName === className) {
            parentClassName = undefined;
            break;
          }
          parentStructTypeIdx = ctx.structMap.get(parentClassName);
          parentFields = ctx.structFields.get(parentClassName) ?? [];
          // Record parent-child relationship
          ctx.classParentMap.set(className, parentClassName);
          // Mark parent struct as non-final so it can be extended
          if (parentStructTypeIdx !== undefined) {
            const parentTypeDef = ctx.mod.types[parentStructTypeIdx] as StructTypeDef;
            if (parentTypeDef && parentTypeDef.superTypeIdx === undefined) {
              // Mark parent as extensible (superTypeIdx = -1 means "sub with no super")
              parentTypeDef.superTypeIdx = -1;
            }
          }
        }
      }
    }
  }

  // Pre-register the struct type index BEFORE resolving field types.
  // This allows self-referencing fields (e.g. `next: ListNode | null` in class ListNode)
  // to resolve to `ref null $structTypeIdx` instead of falling back to externref.
  // WasmGC supports recursive types natively via rec groups.
  const structTypeIdx = ctx.mod.types.length;
  const placeholderDef: StructTypeDef = { kind: "struct", name: className, fields: [] };
  ctx.mod.types.push(placeholderDef);
  ctx.structMap.set(className, structTypeIdx);
  ctx.typeIdxToStructName.set(structTypeIdx, className);

  // Find the constructor to determine struct fields from `this.x = ...` assignments
  const ctor = decl.members.find(ts.isConstructorDeclaration) as ts.ConstructorDeclaration | undefined;
  const ownFields: FieldDef[] = [];

  if (ctor?.body) {
    for (const stmt of ctor.body.statements) {
      // Skip super() calls — they don't define new fields
      if (
        ts.isExpressionStatement(stmt) &&
        ts.isCallExpression(stmt.expression) &&
        stmt.expression.expression.kind === ts.SyntaxKind.SuperKeyword
      ) {
        continue;
      }
      if (
        ts.isExpressionStatement(stmt) &&
        ts.isBinaryExpression(stmt.expression) &&
        stmt.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(stmt.expression.left) &&
        stmt.expression.left.expression.kind === ts.SyntaxKind.ThisKeyword
      ) {
        const rawName = stmt.expression.left.name.text;
        const fieldName = ts.isPrivateIdentifier(stmt.expression.left.name) ? "__priv_" + rawName.slice(1) : rawName;
        // Skip if this field is already defined in parent
        if (parentFields.some((f) => f.name === fieldName)) continue;
        const fieldTsType = ctx.checker.getTypeAtLocation(stmt.expression.left);
        const fieldType = resolveWasmType(ctx, fieldTsType);
        if (!ownFields.some((f) => f.name === fieldName)) {
          ownFields.push({ name: fieldName, type: fieldType, mutable: true });
        }
      }
    }
  }

  // Also collect fields from property declarations (class Point { x: number; y: number; })
  // Skip static properties — they become module globals, not struct fields
  for (const member of decl.members) {
    if (ts.isPropertyDeclaration(member) && member.name) {
      const fieldName = resolveClassMemberName(ctx, member.name);
      if (fieldName === undefined) continue; // dynamic computed name — skip
      if (hasStaticModifier(member)) continue; // handled below
      // Skip if this field is already defined in parent
      if (parentFields.some((f) => f.name === fieldName)) continue;
      if (!ownFields.some((f) => f.name === fieldName)) {
        const fieldTsType = ctx.checker.getTypeAtLocation(member);
        const fieldType = resolveWasmType(ctx, fieldTsType);
        ownFields.push({ name: fieldName, type: fieldType, mutable: true });
      }
    }
  }

  // Build full fields list: parent fields first, then own fields
  const fields: FieldDef[] = [...parentFields, ...ownFields];

  // Widen non-null ref fields to ref_null so the constructor can create the
  // struct with ref.null default values before assigning real values.
  // Without this, struct.new would require non-null refs for fields that
  // haven't been initialized yet, causing a Wasm validation error.
  for (const field of fields) {
    if (field.type.kind === "ref") {
      field.type = { kind: "ref_null", typeIdx: field.type.typeIdx };
    }
  }

  // Register the struct type with optional super-type
  // Assign a unique class tag for instanceof support
  const classTag = ctx.classTagCounter++;
  ctx.classTagMap.set(className, classTag);

  // Add hidden __tag field at the beginning for instanceof discrimination
  // Only for root classes — child classes inherit __tag via parentFields.
  // Also treat as root when extending a built-in (parentClassName set but no
  // struct type registered), since built-ins have no Wasm struct fields to inherit.
  if (!parentClassName || parentStructTypeIdx === undefined) {
    fields.unshift({ name: "__tag", type: { kind: "i32" }, mutable: false });
  }

  // Update the placeholder struct type with resolved fields
  const structDef: StructTypeDef = { kind: "struct", name: className, fields };
  if (parentStructTypeIdx !== undefined) {
    structDef.superTypeIdx = parentStructTypeIdx;
  }
  ctx.mod.types[structTypeIdx] = structDef;
  ctx.structFields.set(className, fields);

  // Register a prototype singleton global (externref, lazily initialized)
  // Used by ClassName.prototype and Object.getPrototypeOf(instance).
  {
    const protoGlobalIdx = nextModuleGlobalIdx(ctx);
    ctx.mod.globals.push({
      name: `__proto_${className}`,
      type: { kind: "externref" },
      mutable: true,
      init: [{ op: "ref.null.extern" }],
    });
    ctx.protoGlobals.set(className, protoGlobalIdx);
  }

  // Register constructor function: takes ctor params, returns (ref $structTypeIdx)
  const ctorParams: ValType[] = [];
  const ctorName = `${className}_new`;
  if (ctor) {
    for (let i = 0; i < ctor.parameters.length; i++) {
      const param = ctor.parameters[i]!;
      if (param.dotDotDotToken) {
        // Rest parameter: ...args: T[] -> single (ref $__vec_elemKind) param (#382)
        const paramType = ctx.checker.getTypeAtLocation(param);
        const typeArgs = ctx.checker.getTypeArguments(paramType as ts.TypeReference);
        const elemTsType = typeArgs[0];
        const elemType: ValType = elemTsType ? resolveWasmType(ctx, elemTsType) : { kind: "f64" };
        const elemKey =
          elemType.kind === "ref" || elemType.kind === "ref_null"
            ? `ref_${(elemType as { typeIdx: number }).typeIdx}`
            : elemType.kind;
        const vecTypeIdx = getOrRegisterVecType(ctx, elemKey, elemType);
        const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
        ctorParams.push({ kind: "ref_null", typeIdx: vecTypeIdx });
        ctx.funcRestParams.set(ctorName, {
          restIndex: i,
          elemType,
          arrayTypeIdx: arrTypeIdx,
          vecTypeIdx,
        });
      } else {
        const paramType = ctx.checker.getTypeAtLocation(param);
        let wasmType = resolveWasmType(ctx, paramType);
        // Widen ref to ref_null for params with defaults
        if (param.initializer && wasmType.kind === "ref") {
          wasmType = { kind: "ref_null", typeIdx: (wasmType as any).typeIdx };
        }
        ctorParams.push(wasmType);
      }
    }
  }
  const ctorResults: ValType[] = [{ kind: "ref", typeIdx: structTypeIdx }];
  const ctorTypeIdx = addFuncType(ctx, ctorParams, ctorResults, `${className}_new_type`);
  const ctorFuncIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.funcMap.set(ctorName, ctorFuncIdx);

  ctx.mod.functions.push({
    name: ctorName,
    typeIdx: ctorTypeIdx,
    locals: [],
    body: [],
    exported: false,
  });

  // Register method functions (own methods defined on this class)
  // Skip abstract methods — they have no body and are implemented by subclasses
  const ownMethodNames = new Set<string>();
  for (const member of decl.members) {
    if (ts.isMethodDeclaration(member) && member.name) {
      const methodName = resolveClassMemberName(ctx, member.name);
      if (methodName === undefined) continue; // dynamic computed name — skip
      ownMethodNames.add(methodName);

      // Abstract methods have no body — skip generating a wasm function stub
      if (hasAbstractModifier(member)) continue;

      const fullName = `${className}_${methodName}`;
      const isStatic = hasStaticModifier(member);

      // ES2015 14.5.14 step 21: static methods cannot be named 'prototype'
      if (isStatic && methodName === "prototype") {
        ctx.classThrowsOnEval.add(className);
      }

      if (isStatic) {
        ctx.staticMethodSet.add(fullName);
      } else {
        ctx.classMethodSet.add(fullName);
      }

      // Track generator methods (method*)
      const isGeneratorMethod = member.asteriskToken !== undefined;
      if (isGeneratorMethod) {
        ctx.generatorFunctions.add(fullName);
      }

      // Skip if a function with this name is already registered (e.g., when
      // both a static and instance method share the same name, they produce
      // the same function name — avoid creating duplicate placeholders).
      if (ctx.funcMap.has(fullName)) continue;

      // Static methods have no self parameter; instance methods get self: (ref $structTypeIdx)
      const methodParams: ValType[] = isStatic ? [] : [{ kind: "ref", typeIdx: structTypeIdx }];
      for (const param of member.parameters) {
        const paramType = ctx.checker.getTypeAtLocation(param);
        let wasmType = resolveWasmType(ctx, paramType);
        // Widen ref to ref_null for params with defaults (caller passes ref.null as sentinel)
        if (param.initializer && wasmType.kind === "ref") {
          wasmType = { kind: "ref_null", typeIdx: (wasmType as any).typeIdx };
        }
        methodParams.push(wasmType);
      }

      // Detect async methods — unwrap Promise<T> to T for Wasm return type
      // Exclude async generators: they return AsyncGenerator objects, not Promises.
      const isAsyncMethod = member.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false;
      if (isAsyncMethod && !isGeneratorMethod) {
        ctx.asyncFunctions.add(fullName);
      }

      const sig = ctx.checker.getSignatureFromDeclaration(member);
      let methodResults: ValType[] = [];
      if (isGeneratorMethod) {
        // Generator methods return externref (JS Generator object)
        methodResults = [{ kind: "externref" }];
      } else if (sig) {
        let retType = ctx.checker.getReturnTypeOfSignature(sig);
        if (isAsyncMethod) {
          retType = unwrapPromiseType(retType, ctx.checker);
        }
        if (!isVoidType(retType)) {
          methodResults = [resolveWasmType(ctx, retType)];
        }
      }

      // Track methods that read `arguments` (#1053) so callers can
      // populate the __extras_argv global with runtime args beyond the
      // formal param count.
      if (member.body && bodyUsesArguments(member.body)) {
        ctx.funcUsesArguments.add(fullName);
      }

      const methodTypeIdx = addFuncType(ctx, methodParams, methodResults, `${fullName}_type`);
      const methodFuncIdx = ctx.numImportFuncs + ctx.mod.functions.length;
      ctx.funcMap.set(fullName, methodFuncIdx);

      ctx.mod.functions.push({
        name: fullName,
        typeIdx: methodTypeIdx,
        locals: [],
        body: [],
        exported: false,
      });
    }
  }

  // Register getter/setter accessor functions
  for (const member of decl.members) {
    // ES2015 14.5.14 step 21: static accessors cannot be named 'prototype'
    if (
      (ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) &&
      member.name &&
      hasStaticModifier(member)
    ) {
      const accName = resolveClassMemberName(ctx, member.name);
      if (accName === "prototype") {
        ctx.classThrowsOnEval.add(className);
      }
    }

    if (ts.isGetAccessorDeclaration(member) && member.name) {
      const propName = resolveClassMemberName(ctx, member.name);
      if (propName === undefined) continue; // dynamic computed name — skip
      const accessorKey = `${className}_${propName}`;
      ctx.classAccessorSet.add(accessorKey);
      if (hasStaticModifier(member)) {
        ctx.staticAccessorSet.add(accessorKey);
      }

      const getterName = `${className}_get_${propName}`;
      // Skip if a function with this name is already registered (e.g., when
      // both a static and instance getter share the same computed property name,
      // they produce the same function name — avoid creating duplicates that
      // leave empty-body placeholders causing "stack fallthru" validation errors).
      if (ctx.funcMap.has(getterName)) continue;
      // Getter takes self, returns the accessor return type
      const getterParams: ValType[] = [{ kind: "ref", typeIdx: structTypeIdx }];
      const sig = ctx.checker.getSignatureFromDeclaration(member);
      let getterResults: ValType[] = [];
      if (sig) {
        const retType = ctx.checker.getReturnTypeOfSignature(sig);
        if (!isVoidType(retType)) {
          getterResults = [resolveWasmType(ctx, retType)];
        }
      }

      const getterTypeIdx = addFuncType(ctx, getterParams, getterResults, `${getterName}_type`);
      const getterFuncIdx = ctx.numImportFuncs + ctx.mod.functions.length;
      ctx.funcMap.set(getterName, getterFuncIdx);

      ctx.mod.functions.push({
        name: getterName,
        typeIdx: getterTypeIdx,
        locals: [],
        body: [],
        exported: false,
      });
    }

    if (ts.isSetAccessorDeclaration(member) && member.name) {
      const propName = resolveClassMemberName(ctx, member.name);
      if (propName === undefined) continue; // dynamic computed name — skip
      const accessorKey = `${className}_${propName}`;
      ctx.classAccessorSet.add(accessorKey);
      if (hasStaticModifier(member)) {
        ctx.staticAccessorSet.add(accessorKey);
      }

      const setterName = `${className}_set_${propName}`;
      // Skip if already registered (same collision guard as getter above)
      if (ctx.funcMap.has(setterName)) continue;
      // Setter takes self + value, returns void
      const setterParams: ValType[] = [{ kind: "ref", typeIdx: structTypeIdx }];
      for (const param of member.parameters) {
        const paramType = ctx.checker.getTypeAtLocation(param);
        setterParams.push(resolveWasmType(ctx, paramType));
      }

      const setterTypeIdx = addFuncType(ctx, setterParams, [], `${setterName}_type`);
      const setterFuncIdx = ctx.numImportFuncs + ctx.mod.functions.length;
      ctx.funcMap.set(setterName, setterFuncIdx);

      ctx.mod.functions.push({
        name: setterName,
        typeIdx: setterTypeIdx,
        locals: [],
        body: [],
        exported: false,
      });
    }
  }

  // Register inherited methods and accessors: if parent has methods/accessors
  // that child doesn't override, map ChildClass_X → ParentClass_X func index
  if (parentClassName) {
    // Collect own accessor names for override detection
    const ownAccessorNames = new Set<string>();
    for (const member of decl.members) {
      if ((ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) && member.name) {
        const accName = resolveClassMemberName(ctx, member.name);
        if (accName) ownAccessorNames.add(accName);
      }
    }

    // Walk the parent chain to find all inherited methods and accessors
    // Guard against circular inheritance (e.g., class X extends X)
    const visitedAncestors = new Set<string>();
    let ancestor: string | undefined = parentClassName;
    while (ancestor && !visitedAncestors.has(ancestor)) {
      visitedAncestors.add(ancestor);
      // Inherit methods
      for (const [key, funcIdx] of ctx.funcMap) {
        if (key.startsWith(`${ancestor}_`) && !key.endsWith("_new") && !key.endsWith("_type")) {
          const suffix = key.substring(ancestor.length + 1);
          // Skip constructor-related entries
          if (suffix === "new" || suffix.startsWith("new_")) continue;
          // Check if this is a getter/setter (get_X or set_X)
          const getMatch = suffix.match(/^get_(.+)$/);
          const setMatch = suffix.match(/^set_(.+)$/);
          if (getMatch || setMatch) {
            // Accessor inheritance
            const accPropName = (getMatch || setMatch)![1]!;
            if (!ownAccessorNames.has(accPropName)) {
              const childFullName = `${className}_${suffix}`;
              if (!ctx.funcMap.has(childFullName)) {
                ctx.funcMap.set(childFullName, funcIdx);
              }
              // Also inherit accessor set entry
              const parentAccessorKey = `${ancestor}_${accPropName}`;
              const childAccessorKey = `${className}_${accPropName}`;
              if (ctx.classAccessorSet.has(parentAccessorKey) && !ctx.classAccessorSet.has(childAccessorKey)) {
                ctx.classAccessorSet.add(childAccessorKey);
              }
            }
          } else {
            // Regular method — inherit from parent (works for all method names,
            // including those with underscores like my_method) (#799 WI6)
            const childFullName = `${className}_${suffix}`;
            if (!ownMethodNames.has(suffix) && !ctx.funcMap.has(childFullName)) {
              ctx.funcMap.set(childFullName, funcIdx);
              ctx.classMethodSet.add(childFullName);
            }
          }
        }
      }
      ancestor = ctx.classParentMap.get(ancestor);
    }
  }

  // #1047 — collect own (non-static) method + accessor names so `_wrapForHost`
  // can present `C.prototype` with a method-only own-key set. Instance fields
  // (ownFields) are intentionally excluded — they must NOT appear as own
  // properties of the prototype.
  {
    const protoMethodNames: string[] = [];
    const seen = new Set<string>();
    for (const member of decl.members) {
      if (hasStaticModifier(member)) continue;
      if (
        ts.isMethodDeclaration(member) ||
        ts.isGetAccessorDeclaration(member) ||
        ts.isSetAccessorDeclaration(member)
      ) {
        if (!member.name) continue;
        const n = resolveClassMemberName(ctx, member.name);
        if (n === undefined) continue;
        if (seen.has(n)) continue;
        seen.add(n);
        protoMethodNames.push(n);
      }
    }
    ctx.classMethodNames.set(className, protoMethodNames);
  }

  // Register static properties as module globals
  for (const member of decl.members) {
    if (ts.isPropertyDeclaration(member) && member.name && hasStaticModifier(member)) {
      const propName = resolveClassMemberName(ctx, member.name);
      if (propName === undefined) continue; // dynamic computed name — skip
      const fullName = `${className}_${propName}`;
      if (ctx.staticProps.has(fullName)) continue; // skip if already registered

      const propTsType = ctx.checker.getTypeAtLocation(member);
      const wasmType = resolveWasmType(ctx, propTsType);

      // Build null/zero initializer for the global
      const init: Instr[] =
        wasmType.kind === "f64"
          ? [{ op: "f64.const", value: 0 }]
          : wasmType.kind === "i32"
            ? [{ op: "i32.const", value: 0 }]
            : wasmType.kind === "i64"
              ? [{ op: "i64.const", value: 0n }]
              : wasmType.kind === "ref_null" || wasmType.kind === "ref"
                ? [
                    {
                      op: "ref.null",
                      typeIdx: (wasmType as { typeIdx: number }).typeIdx,
                    },
                  ]
                : [{ op: "ref.null.extern" }];

      // Widen non-nullable ref to ref_null so the global can hold null initially
      const globalType: ValType =
        wasmType.kind === "ref"
          ? {
              kind: "ref_null",
              typeIdx: (wasmType as { typeIdx: number }).typeIdx,
            }
          : wasmType;

      const globalIdx = nextModuleGlobalIdx(ctx);
      ctx.mod.globals.push({
        name: `__static_${fullName}`,
        type: globalType,
        mutable: true,
        init,
      });
      ctx.staticProps.set(fullName, globalIdx);

      // Store initializer expression for later compilation
      if (member.initializer) {
        ctx.staticInitExprs.push({
          globalIdx,
          initializer: member.initializer,
        });
      }
    }
  }
}

/**
 * For a generic function, find the first call site in the source and resolve
 * concrete param/return types from the checker's instantiated signature.
 * Returns null if no call site is found (function stays with erased types).
 */

export const INTERNAL_FIELD_NAMES = new Set(["__tag", "__proto__"]);

/**
 * Default property flags: writable (bit 0) + enumerable (bit 1) + configurable (bit 2).
 * Matches PROP_FLAG_WRITABLE | PROP_FLAG_ENUMERABLE | PROP_FLAG_CONFIGURABLE from object-ops.ts.
 */
export const PROP_FLAGS_DEFAULT = 0x07;

/**
 * Build the per-shape default property flags table.
 * Iterates all struct types registered via structMap (classes, anonymous objects,
 * interfaces, type aliases) and creates a Uint8Array of default flags for each.
 * One byte per user-visible field; internal fields (__tag) are excluded.
 *
 * This table is purely compile-time metadata with zero runtime overhead.
 * Future subtasks (#797c Object.defineProperty, #797d Object.keys) will
 * emit code that reads from this table at runtime.
 */
export function buildShapePropFlagsTable(ctx: CodegenContext): void {
  for (const [name, typeIdx] of ctx.structMap) {
    const fields = ctx.structFields.get(name);
    if (!fields || fields.length === 0) continue;

    // Count user-visible fields (exclude internal fields)
    const userFields = fields.filter((f) => !INTERNAL_FIELD_NAMES.has(f.name));
    if (userFields.length === 0) continue;

    // All user-visible properties get default flags (writable + enumerable + configurable)
    const flags = new Uint8Array(userFields.length);
    flags.fill(PROP_FLAGS_DEFAULT);

    ctx.shapePropFlags.set(typeIdx, flags);
  }
}

/** Scan all function bodies for ref.func instructions and record their targets */
export function collectDeclaredFuncRefs(ctx: CodegenContext): void {
  const refs = new Set<number>();
  function scanInstrs(instrs: Instr[]): void {
    for (const instr of instrs) {
      if (instr.op === "ref.func") {
        refs.add((instr as { op: "ref.func"; funcIdx: number }).funcIdx);
      }
      // Recurse into nested instruction arrays (if/then/else, block/body, loop, try/catch)
      if ("body" in instr && Array.isArray((instr as any).body)) {
        scanInstrs((instr as any).body);
      }
      if ("then" in instr && Array.isArray((instr as any).then)) {
        scanInstrs((instr as any).then);
      }
      if ("else" in instr && Array.isArray((instr as any).else)) {
        scanInstrs((instr as any).else);
      }
      if ("catches" in instr && Array.isArray((instr as any).catches)) {
        for (const c of (instr as any).catches) {
          if (Array.isArray(c.body)) scanInstrs(c.body);
        }
      }
      if ("catchAll" in instr && Array.isArray((instr as any).catchAll)) {
        scanInstrs((instr as any).catchAll);
      }
    }
  }
  for (const func of ctx.mod.functions) {
    scanInstrs(func.body);
  }
  if (refs.size > 0) {
    ctx.mod.declaredFuncRefs = [...refs].sort((a, b) => a - b);
  }
}

/** Compile constructor and method bodies for a class declaration */
export function compileClassBodies(
  ctx: CodegenContext,
  decl: ts.ClassDeclaration | ts.ClassExpression,
  funcByName: Map<string, number>,
  syntheticName?: string,
): void {
  const className = syntheticName ?? decl.name?.text;
  if (!className) {
    reportError(ctx, decl, "Cannot compile unnamed class");
    return;
  }
  const structTypeIdx = ctx.structMap.get(className);
  const fields = ctx.structFields.get(className);
  if (structTypeIdx === undefined || !fields) {
    reportError(ctx, decl, `Unknown class struct type: ${className}`);
    return;
  }

  // Compile constructor
  const ctor = decl.members.find(ts.isConstructorDeclaration) as ts.ConstructorDeclaration | undefined;
  const ctorName = `${className}_new`;
  const ctorLocalIdx = funcByName.get(ctorName);
  if (ctorLocalIdx !== undefined) {
    const func = ctx.mod.functions[ctorLocalIdx]!;
    const params: { name: string; type: ValType }[] = [];
    if (ctor) {
      for (let pi = 0; pi < ctor.parameters.length; pi++) {
        const param = ctor.parameters[pi]!;
        const paramName = ts.isIdentifier(param.name) ? param.name.text : `__param${pi}`;
        const paramType = ctx.checker.getTypeAtLocation(param);
        let wasmType = resolveWasmType(ctx, paramType);
        // Widen ref to ref_null for params with defaults or optional params
        // (caller passes ref.null as sentinel). Must match collection phase (#702)
        if ((param.initializer || param.questionToken) && wasmType.kind === "ref") {
          wasmType = { kind: "ref_null", typeIdx: (wasmType as { kind: "ref"; typeIdx: number }).typeIdx };
        }
        params.push({ name: paramName, type: wasmType });
      }
    }

    const fctx: FunctionContext = {
      name: ctorName,
      params,
      locals: [],
      localMap: new Map(),
      returnType: { kind: "ref", typeIdx: structTypeIdx },
      body: [],
      blockDepth: 0,
      breakStack: [],
      continueStack: [],
      labelMap: new Map(),
      savedBodies: [],
      isConstructor: true,
    };

    // Re-resolve the constructor function type now that all class struct types
    // are registered. Constructor parameter types that reference forward-declared
    // classes may have resolved to externref during the collection phase.
    {
      const resolvedParams = params.map((p) => p.type);
      const resolvedResults: ValType[] = [{ kind: "ref", typeIdx: structTypeIdx }];
      const updatedTypeIdx = addFuncType(ctx, resolvedParams, resolvedResults, `${ctorName}_type`);
      if (updatedTypeIdx !== func.typeIdx) {
        func.typeIdx = updatedTypeIdx;
      }
    }

    for (let i = 0; i < params.length; i++) {
      fctx.localMap.set(params[i]!.name, i);
    }

    // Allocate a local for the struct instance
    const selfLocal = allocLocal(fctx, "__self", {
      kind: "ref",
      typeIdx: structTypeIdx,
    });

    // Push default values for all fields, then struct.new
    for (const field of fields) {
      if (field.name === "__tag") {
        // Push the class-specific tag value for instanceof discrimination
        const tagValue = ctx.classTagMap.get(className) ?? 0;
        fctx.body.push({ op: "i32.const", value: tagValue });
      } else if (field.type.kind === "f64") {
        fctx.body.push({ op: "f64.const", value: 0 });
      } else if (field.type.kind === "i32") {
        fctx.body.push({ op: "i32.const", value: 0 });
      } else if (field.type.kind === "externref") {
        fctx.body.push({ op: "ref.null.extern" });
      } else if (field.type.kind === "ref" || field.type.kind === "ref_null") {
        fctx.body.push({ op: "ref.null", typeIdx: field.type.typeIdx });
      } else if ((field.type as any).kind === "i64") {
        fctx.body.push({ op: "i64.const", value: 0n });
      } else if ((field.type as any).kind === "eqref") {
        fctx.body.push({ op: "ref.null.eq" });
      } else {
        // Fallback for any unhandled type — push i32 0
        fctx.body.push({ op: "i32.const", value: 0 });
      }
    }
    fctx.body.push({ op: "struct.new", typeIdx: structTypeIdx });
    fctx.body.push({ op: "local.set", index: selfLocal });

    // __proto__ initialization: deferred to #802 (dynamic prototype support)

    // Compile constructor body — `this` maps to __self local
    fctx.localMap.set("this", selfLocal);
    ctx.currentFunc = fctx;

    // Emit default-value initialization for constructor parameters with initializers.
    // For each param with a default value, check if the caller passed the zero/null
    // sentinel (meaning the argument was omitted) and if so, compile the initializer
    // expression and assign it to the param local.
    if (ctor) {
      for (let i = 0; i < ctor.parameters.length; i++) {
        const param = ctor.parameters[i]!;
        if (!param.initializer) continue;

        const paramIdx = i;
        const paramType = params[i]!.type;

        // Build the "then" block: compile default expression, local.set
        const savedBody = pushBody(fctx);
        const ctorDfltType = compileExpression(ctx, fctx, param.initializer, paramType);
        if (ctorDfltType && !valTypesMatch(ctorDfltType, paramType)) {
          coerceType(ctx, fctx, ctorDfltType, paramType);
        }
        fctx.body.push({ op: "local.set", index: paramIdx });
        const thenInstrs = fctx.body;
        popBody(fctx, savedBody);

        // Emit the null/zero check + conditional assignment
        if (paramType.kind === "externref") {
          fctx.body.push({ op: "local.get", index: paramIdx });
          fctx.body.push({ op: "ref.is_null" });
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: thenInstrs,
          });
        } else if (paramType.kind === "ref_null" || paramType.kind === "ref") {
          fctx.body.push({ op: "local.get", index: paramIdx });
          fctx.body.push({ op: "ref.is_null" });
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: thenInstrs,
          });
        } else if (paramType.kind === "i32") {
          fctx.body.push({ op: "local.get", index: paramIdx });
          fctx.body.push({ op: "i32.eqz" });
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: thenInstrs,
          });
        } else if (paramType.kind === "f64") {
          // NaN sentinel check: x != x is true iff x is NaN (#787)
          fctx.body.push({ op: "local.get", index: paramIdx });
          fctx.body.push({ op: "local.get", index: paramIdx });
          fctx.body.push({ op: "f64.ne" });
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: thenInstrs,
          });
        }
      }
    }

    // When a child class has no explicit constructor, run inherited field
    // initializers from the parent chain (implicit super() semantics).
    // This must happen before own field initializers.
    if (!ctor) {
      const parentClassName = ctx.classParentMap.get(className);
      if (parentClassName) {
        // Walk the parent chain (grandparent first) and compile field initializers
        // Guard against circular inheritance (e.g., class X extends X)
        const ancestors: string[] = [];
        const visitedAnc = new Set<string>();
        let anc: string | undefined = parentClassName;
        while (anc && !visitedAnc.has(anc)) {
          visitedAnc.add(anc);
          ancestors.unshift(anc);
          anc = ctx.classParentMap.get(anc);
        }
        for (const ancName of ancestors) {
          const ancDecl = ctx.classDeclarationMap.get(ancName);
          if (!ancDecl) continue;
          for (const member of ancDecl.members) {
            if (ts.isPropertyDeclaration(member) && member.name && member.initializer && !hasStaticModifier(member)) {
              const fieldName = resolveClassMemberName(ctx, member.name);
              if (fieldName === undefined) continue;
              const fieldIdx = fields.findIndex((f) => f.name === fieldName);
              if (fieldIdx !== -1) {
                fctx.body.push({ op: "local.get", index: selfLocal });
                compileExpression(ctx, fctx, member.initializer, fields[fieldIdx]!.type);
                fctx.body.push({ op: "struct.set", typeIdx: structTypeIdx, fieldIdx });
              }
            }
          }
          // Also run constructor body assignments (this.x = ...) from the parent
          const ancCtor = ancDecl.members.find(ts.isConstructorDeclaration) as ts.ConstructorDeclaration | undefined;
          if (ancCtor?.body) {
            for (const stmt of ancCtor.body.statements) {
              if (
                ts.isExpressionStatement(stmt) &&
                ts.isCallExpression(stmt.expression) &&
                stmt.expression.expression.kind === ts.SyntaxKind.SuperKeyword
              ) {
                continue; // skip super() — already handled by ancestor chain order
              }
              if (
                ts.isExpressionStatement(stmt) &&
                ts.isBinaryExpression(stmt.expression) &&
                stmt.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                ts.isPropertyAccessExpression(stmt.expression.left) &&
                stmt.expression.left.expression.kind === ts.SyntaxKind.ThisKeyword
              ) {
                const rawName = stmt.expression.left.name.text;
                const fieldName = ts.isPrivateIdentifier(stmt.expression.left.name)
                  ? "__priv_" + rawName.slice(1)
                  : rawName;
                const fieldIdx = fields.findIndex((f) => f.name === fieldName);
                if (fieldIdx !== -1) {
                  fctx.body.push({ op: "local.get", index: selfLocal });
                  compileExpression(ctx, fctx, stmt.expression.right, fields[fieldIdx]!.type);
                  fctx.body.push({ op: "struct.set", typeIdx: structTypeIdx, fieldIdx });
                }
              }
            }
          }
        }
      }
    }

    // Compile field initializers from property declarations (e.g., x: number = 42, #x: number = 42)
    for (const member of decl.members) {
      if (ts.isPropertyDeclaration(member) && member.name && member.initializer && !hasStaticModifier(member)) {
        const fieldName = resolveClassMemberName(ctx, member.name);
        if (fieldName === undefined) continue; // dynamic computed name — skip
        const fieldIdx = fields.findIndex((f) => f.name === fieldName);
        if (fieldIdx !== -1) {
          fctx.body.push({ op: "local.get", index: selfLocal });
          compileExpression(ctx, fctx, member.initializer, fields[fieldIdx]!.type);
          fctx.body.push({ op: "struct.set", typeIdx: structTypeIdx, fieldIdx });
        }
      }
    }

    if (ctor?.body) {
      for (const stmt of ctor.body.statements) {
        // Handle super(args) calls: inline parent constructor field initialization
        if (
          ts.isExpressionStatement(stmt) &&
          ts.isCallExpression(stmt.expression) &&
          stmt.expression.expression.kind === ts.SyntaxKind.SuperKeyword
        ) {
          compileSuperCall(ctx, fctx, className, selfLocal, stmt.expression, fields);
          continue;
        }
        compileStatement(ctx, fctx, stmt);
      }
    }

    // Return the struct instance
    fctx.body.push({ op: "local.get", index: selfLocal });

    cacheStringLiterals(ctx, fctx);
    deduplicateLocals(fctx);
    func.locals = fctx.locals;
    func.body = fctx.body;
    ctx.currentFunc = null;
  }

  // Compile methods (instance and static)
  // Track which methods have been compiled to avoid overwriting when
  // both static and instance methods share the same name.
  const compiledMethods = new Set<string>();
  for (const member of decl.members) {
    if (ts.isMethodDeclaration(member) && member.name) {
      const methodName = resolveClassMemberName(ctx, member.name);
      if (methodName === undefined) continue; // dynamic computed name — skip
      const fullName = `${className}_${methodName}`;
      if (compiledMethods.has(fullName)) continue; // already compiled
      compiledMethods.add(fullName);
      const isStatic = ctx.staticMethodSet.has(fullName);
      const methodLocalIdx = funcByName.get(fullName);
      if (methodLocalIdx === undefined) continue;

      const func = ctx.mod.functions[methodLocalIdx]!;
      const sig = ctx.checker.getSignatureFromDeclaration(member);
      const retType = sig ? ctx.checker.getReturnTypeOfSignature(sig) : undefined;

      // Static methods have no self param; instance methods get self as first param
      const params: { name: string; type: ValType }[] = isStatic
        ? []
        : [{ name: "this", type: { kind: "ref", typeIdx: structTypeIdx } }];
      for (let pi = 0; pi < member.parameters.length; pi++) {
        const param = member.parameters[pi]!;
        const paramName = ts.isIdentifier(param.name) ? param.name.text : `__param${pi}`;
        const paramType = ctx.checker.getTypeAtLocation(param);
        let wasmType = resolveWasmType(ctx, paramType);
        // Widen ref to ref_null for params with defaults or optional params
        // (caller passes ref.null as sentinel). Must match collection phase (#702)
        if ((param.initializer || param.questionToken) && wasmType.kind === "ref") {
          wasmType = { kind: "ref_null", typeIdx: (wasmType as { kind: "ref"; typeIdx: number }).typeIdx };
        }
        params.push({ name: paramName, type: wasmType });
      }

      const isGeneratorMethod = member.asteriskToken !== undefined;
      const isAsyncMethod = member.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false;

      const fctx: FunctionContext = {
        name: fullName,
        params,
        locals: [],
        localMap: new Map(),
        returnType: isGeneratorMethod
          ? { kind: "externref" }
          : retType && !isVoidType(retType)
            ? resolveWasmType(ctx, retType)
            : null,
        body: [],
        blockDepth: 0,
        breakStack: [],
        continueStack: [],
        labelMap: new Map(),
        savedBodies: [],
        isGenerator: isGeneratorMethod,
      };

      // Re-resolve the function type now that all class struct types are registered.
      // During the collection phase, forward-referenced class types (e.g., a method
      // returning a class declared later in the source) resolve to externref because
      // the target struct type doesn't exist yet. By this point all struct types are
      // registered, so re-resolving produces the correct ref types.
      {
        const resolvedParams = params.map((p) => p.type);
        const resolvedResults: ValType[] = fctx.returnType ? [fctx.returnType] : [];
        const updatedTypeIdx = addFuncType(ctx, resolvedParams, resolvedResults, `${fullName}_type`);
        if (updatedTypeIdx !== func.typeIdx) {
          func.typeIdx = updatedTypeIdx;
        }
      }

      for (let i = 0; i < params.length; i++) {
        fctx.localMap.set(params[i]!.name, i);
      }

      ctx.currentFunc = fctx;

      // Emit default-value initialization for method parameters with initializers.
      for (let pi = 0; pi < member.parameters.length; pi++) {
        const param = member.parameters[pi]!;
        if (!param.initializer) continue;

        const paramLocalIdx = isStatic ? pi : pi + 1; // account for 'this' param
        const paramType = params[paramLocalIdx]!.type;

        // Build the "then" block: compile default expression, local.set
        const savedBody = pushBody(fctx);
        const methDfltType = compileExpression(ctx, fctx, param.initializer, paramType);
        if (methDfltType && !valTypesMatch(methDfltType, paramType)) {
          coerceType(ctx, fctx, methDfltType, paramType);
        }
        fctx.body.push({ op: "local.set", index: paramLocalIdx });
        const thenInstrs = fctx.body;
        popBody(fctx, savedBody);

        // Emit the null/zero check + conditional assignment
        if (paramType.kind === "externref") {
          fctx.body.push({ op: "local.get", index: paramLocalIdx });
          fctx.body.push({ op: "ref.is_null" });
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: thenInstrs,
          });
        } else if (paramType.kind === "ref_null" || paramType.kind === "ref") {
          fctx.body.push({ op: "local.get", index: paramLocalIdx });
          fctx.body.push({ op: "ref.is_null" });
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: thenInstrs,
          });
        } else if (paramType.kind === "i32") {
          fctx.body.push({ op: "local.get", index: paramLocalIdx });
          fctx.body.push({ op: "i32.eqz" });
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: thenInstrs,
          });
        } else if (paramType.kind === "f64") {
          // NaN sentinel check: x != x is true iff x is NaN (#787)
          fctx.body.push({ op: "local.get", index: paramLocalIdx });
          fctx.body.push({ op: "local.get", index: paramLocalIdx });
          fctx.body.push({ op: "f64.ne" });
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: thenInstrs,
          });
        }
      }

      // Destructure parameters with binding patterns
      for (let pi = 0; pi < member.parameters.length; pi++) {
        const param = member.parameters[pi]!;
        const paramLocalIdx = isStatic ? pi : pi + 1; // account for 'this' param
        if (ts.isObjectBindingPattern(param.name)) {
          destructureParamObject(ctx, fctx, paramLocalIdx, param.name, params[paramLocalIdx]!.type);
        } else if (ts.isArrayBindingPattern(param.name)) {
          destructureParamArray(ctx, fctx, paramLocalIdx, param.name, params[paramLocalIdx]!.type);
        }
      }

      // Set up `arguments` object if the method body references it (#820).
      // Class methods (like standalone functions) need an arguments vec struct
      // so that `arguments.length` and `arguments[n]` work at runtime.
      if (member.body && bodyUsesArguments(member.body)) {
        const methodParamTypes = params.slice(isStatic ? 0 : 1).map((p) => p.type);
        const paramOffset = isStatic ? 0 : 1; // skip 'this' param for instance methods
        emitArgumentsObject(ctx, fctx, methodParamTypes, paramOffset);
      }

      if (isGeneratorMethod && member.body) {
        // Generator method: eagerly evaluate body, collect yields into a buffer,
        // then wrap with __create_generator to return a Generator-like object.
        // Body is wrapped in try/catch to defer thrown exceptions to first next() (#928).
        const bufferLocal = allocLocal(fctx, "__gen_buffer", { kind: "externref" });
        const pendingThrowLocal = allocLocal(fctx, "__gen_pending_throw", { kind: "externref" });
        const createBufIdx = ctx.funcMap.get("__gen_create_buffer")!;
        fctx.body.push({ op: "call", funcIdx: createBufIdx });
        fctx.body.push({ op: "local.set", index: bufferLocal });
        fctx.body.push({ op: "ref.null.extern" } as unknown as Instr);
        fctx.body.push({ op: "local.set", index: pendingThrowLocal });

        // Wrap body in a block so return can br out
        // Use pushBody/popBody so the outer body stays reachable for global-index
        // fixups when new string-constant imports are added during body compilation.
        const savedGenBody = pushBody(fctx);

        fctx.generatorReturnDepth = 0;
        fctx.blockDepth++;
        for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]!++;
        for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]!++;

        for (const stmt of member.body.statements) {
          compileStatement(ctx, fctx, stmt);
        }

        fctx.blockDepth--;
        for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]!--;
        for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]!--;
        fctx.generatorReturnDepth = undefined;

        const bodyInstrs = fctx.body;
        popBody(fctx, savedGenBody);

        // Wrap generator body block in try/catch to capture exceptions as pending throw
        const tagIdx = ensureExnTag(ctx);
        const getCaughtIdx = ctx.funcMap.get("__get_caught_exception");
        const catchBody: Instr[] = [{ op: "local.set", index: pendingThrowLocal } as unknown as Instr];
        const catchAllBody: Instr[] =
          getCaughtIdx !== undefined
            ? [
                { op: "call", funcIdx: getCaughtIdx } as Instr,
                { op: "local.set", index: pendingThrowLocal } as unknown as Instr,
              ]
            : [];
        fctx.body.push({
          op: "try",
          blockType: { kind: "empty" },
          body: [{ op: "block", blockType: { kind: "empty" }, body: bodyInstrs }],
          catches: [{ tagIdx, body: catchBody }],
          catchAll: catchAllBody.length > 0 ? catchAllBody : undefined,
        } as unknown as Instr);

        // Return __create_generator or __create_async_generator depending on async flag
        const createGenName = isAsyncMethod ? "__create_async_generator" : "__create_generator";
        const createGenIdx = ctx.funcMap.get(createGenName)!;
        fctx.body.push({ op: "local.get", index: bufferLocal });
        fctx.body.push({ op: "local.get", index: pendingThrowLocal });
        fctx.body.push({ op: "call", funcIdx: createGenIdx });
      } else if (member.body) {
        for (const stmt of member.body.statements) {
          compileStatement(ctx, fctx, stmt);
        }
      }

      // Ensure valid return for non-void, non-generator methods
      if (fctx.returnType && !isGeneratorMethod) {
        const lastInstr = fctx.body[fctx.body.length - 1];
        if (!lastInstr || lastInstr.op !== "return") {
          if (fctx.returnType.kind === "f64") {
            fctx.body.push({ op: "f64.const", value: 0 });
          } else if (fctx.returnType.kind === "i32") {
            fctx.body.push({ op: "i32.const", value: 0 });
          } else if (fctx.returnType.kind === "externref") {
            fctx.body.push({ op: "ref.null.extern" });
          } else if (fctx.returnType.kind === "ref" || fctx.returnType.kind === "ref_null") {
            fctx.body.push({
              op: "ref.null",
              typeIdx: fctx.returnType.typeIdx,
            });
          }
        }
      }

      cacheStringLiterals(ctx, fctx);
      deduplicateLocals(fctx);
      func.locals = fctx.locals;
      func.body = fctx.body;
      ctx.currentFunc = null;
    }
  }

  // Compile getter/setter accessor bodies
  // Track which accessors have been compiled to avoid overwriting when
  // both static and instance accessors share the same computed property name.
  const compiledAccessors = new Set<string>();
  for (const member of decl.members) {
    if (ts.isGetAccessorDeclaration(member) && member.name) {
      const propName = resolveClassMemberName(ctx, member.name);
      if (propName === undefined) continue; // dynamic computed name — skip
      const getterName = `${className}_get_${propName}`;
      if (compiledAccessors.has(getterName)) continue; // already compiled
      compiledAccessors.add(getterName);
      const getterLocalIdx = funcByName.get(getterName);
      if (getterLocalIdx === undefined) continue;

      const func = ctx.mod.functions[getterLocalIdx]!;
      const sig = ctx.checker.getSignatureFromDeclaration(member);
      const retType = sig ? ctx.checker.getReturnTypeOfSignature(sig) : undefined;

      const params: { name: string; type: ValType }[] = [
        { name: "this", type: { kind: "ref", typeIdx: structTypeIdx } },
      ];

      const fctx: FunctionContext = {
        name: getterName,
        params,
        locals: [],
        localMap: new Map(),
        returnType: retType && !isVoidType(retType) ? resolveWasmType(ctx, retType) : null,
        body: [],
        blockDepth: 0,
        breakStack: [],
        continueStack: [],
        labelMap: new Map(),
        savedBodies: [],
      };

      // Re-resolve getter function type (see method type re-resolution above)
      {
        const resolvedParams = params.map((p) => p.type);
        const resolvedResults: ValType[] = fctx.returnType ? [fctx.returnType] : [];
        const updatedTypeIdx = addFuncType(ctx, resolvedParams, resolvedResults, `${getterName}_type`);
        if (updatedTypeIdx !== func.typeIdx) {
          func.typeIdx = updatedTypeIdx;
        }
      }

      for (let i = 0; i < params.length; i++) {
        fctx.localMap.set(params[i]!.name, i);
      }

      ctx.currentFunc = fctx;

      if (member.body) {
        for (const stmt of member.body.statements) {
          compileStatement(ctx, fctx, stmt);
        }
      }

      // Ensure valid return for non-void getters
      if (fctx.returnType) {
        const lastInstr = fctx.body[fctx.body.length - 1];
        if (!lastInstr || lastInstr.op !== "return") {
          if (fctx.returnType.kind === "f64") {
            fctx.body.push({ op: "f64.const", value: 0 });
          } else if (fctx.returnType.kind === "i32") {
            fctx.body.push({ op: "i32.const", value: 0 });
          } else if (fctx.returnType.kind === "externref") {
            fctx.body.push({ op: "ref.null.extern" });
          } else if (fctx.returnType.kind === "ref" || fctx.returnType.kind === "ref_null") {
            fctx.body.push({
              op: "ref.null",
              typeIdx: fctx.returnType.typeIdx,
            });
          }
        }
      }

      cacheStringLiterals(ctx, fctx);
      deduplicateLocals(fctx);
      func.locals = fctx.locals;
      func.body = fctx.body;
      ctx.currentFunc = null;
    }

    if (ts.isSetAccessorDeclaration(member) && member.name) {
      const propName = resolveClassMemberName(ctx, member.name);
      if (propName === undefined) continue; // dynamic computed name — skip
      const setterName = `${className}_set_${propName}`;
      if (compiledAccessors.has(setterName)) continue; // already compiled
      compiledAccessors.add(setterName);
      const setterLocalIdx = funcByName.get(setterName);
      if (setterLocalIdx === undefined) continue;

      const func = ctx.mod.functions[setterLocalIdx]!;

      // First param is self, remaining are the setter parameters
      const params: { name: string; type: ValType }[] = [
        { name: "this", type: { kind: "ref", typeIdx: structTypeIdx } },
      ];
      for (let pi = 0; pi < member.parameters.length; pi++) {
        const param = member.parameters[pi]!;
        const paramName = ts.isIdentifier(param.name) ? param.name.text : `__param${pi}`;
        const paramType = ctx.checker.getTypeAtLocation(param);
        let wasmType = resolveWasmType(ctx, paramType);
        // Widen ref to ref_null for params with defaults or optional params (#702)
        if ((param.initializer || param.questionToken) && wasmType.kind === "ref") {
          wasmType = { kind: "ref_null", typeIdx: (wasmType as { kind: "ref"; typeIdx: number }).typeIdx };
        }
        params.push({ name: paramName, type: wasmType });
      }

      const fctx: FunctionContext = {
        name: setterName,
        params,
        locals: [],
        localMap: new Map(),
        returnType: null, // setters always return void
        body: [],
        blockDepth: 0,
        breakStack: [],
        continueStack: [],
        labelMap: new Map(),
        savedBodies: [],
      };

      // Re-resolve setter function type (see method type re-resolution above)
      {
        const resolvedParams = params.map((p) => p.type);
        const resolvedResults: ValType[] = [];
        const updatedTypeIdx = addFuncType(ctx, resolvedParams, resolvedResults, `${setterName}_type`);
        if (updatedTypeIdx !== func.typeIdx) {
          func.typeIdx = updatedTypeIdx;
        }
      }

      for (let i = 0; i < params.length; i++) {
        fctx.localMap.set(params[i]!.name, i);
      }

      ctx.currentFunc = fctx;

      // Emit default-value initialization for setter parameters with initializers (#377)
      for (let pi = 0; pi < member.parameters.length; pi++) {
        const param = member.parameters[pi]!;
        if (!param.initializer) continue;

        const paramLocalIdx = pi + 1; // account for 'this' param
        const paramType = params[paramLocalIdx]!.type;

        // Build the "then" block: compile default expression, local.set
        const savedBody = pushBody(fctx);
        const getSetDfltType = compileExpression(ctx, fctx, param.initializer, paramType);
        if (getSetDfltType && !valTypesMatch(getSetDfltType, paramType)) {
          coerceType(ctx, fctx, getSetDfltType, paramType);
        }
        fctx.body.push({ op: "local.set", index: paramLocalIdx });
        const thenInstrs = fctx.body;
        popBody(fctx, savedBody);

        // Emit the null/zero check + conditional assignment
        if (paramType.kind === "externref") {
          fctx.body.push({ op: "local.get", index: paramLocalIdx });
          fctx.body.push({ op: "ref.is_null" });
          fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: thenInstrs });
        } else if (paramType.kind === "ref_null" || paramType.kind === "ref") {
          fctx.body.push({ op: "local.get", index: paramLocalIdx });
          fctx.body.push({ op: "ref.is_null" });
          fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: thenInstrs });
        } else if (paramType.kind === "i32") {
          fctx.body.push({ op: "local.get", index: paramLocalIdx });
          fctx.body.push({ op: "i32.eqz" });
          fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: thenInstrs });
        } else if (paramType.kind === "f64") {
          // NaN sentinel check: x != x is true iff x is NaN (#787)
          fctx.body.push({ op: "local.get", index: paramLocalIdx });
          fctx.body.push({ op: "local.get", index: paramLocalIdx });
          fctx.body.push({ op: "f64.ne" });
          fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: thenInstrs });
        }
      }

      if (member.body) {
        for (const stmt of member.body.statements) {
          compileStatement(ctx, fctx, stmt);
        }
      }

      cacheStringLiterals(ctx, fctx);
      deduplicateLocals(fctx);
      func.locals = fctx.locals;
      func.body = fctx.body;
      ctx.currentFunc = null;
    }
  }
}

/**
 * Compile a super(args) call inside a child constructor.
 * This runs the parent constructor's field-initialization logic inline:
 * for each parent field, evaluate the corresponding super argument and
 * store it into the child struct (which includes parent fields at the start).
 */
export function compileSuperCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  childClassName: string,
  selfLocal: number,
  callExpr: ts.CallExpression,
  _allFields: FieldDef[],
): void {
  const parentClassName = ctx.classParentMap.get(childClassName);
  if (!parentClassName) return;

  const parentFields = ctx.structFields.get(parentClassName) ?? [];
  const structTypeIdx = ctx.structMap.get(childClassName)!;

  // Evaluate super(args) and assign to parent fields on the child struct.
  // Skip __tag (immutable, already set by struct.new) and map arguments to
  // the remaining parent fields in order.
  const assignableParentFields = parentFields
    .map((f, idx) => ({ field: f, fieldIdx: idx }))
    .filter((e) => e.field.name !== "__tag");

  // Check if any argument uses spread syntax: super(...args) (#382)
  const hasSuperSpread = callExpr.arguments.some((a) => ts.isSpreadElement(a));

  if (hasSuperSpread) {
    // Handle spread arguments: super(...args) where args is a vec struct { length, data }
    let fieldIdx2 = 0;
    for (const arg of callExpr.arguments) {
      if (ts.isSpreadElement(arg)) {
        const vecType = compileExpression(ctx, fctx, arg.expression);
        if (!vecType || (vecType.kind !== "ref" && vecType.kind !== "ref_null")) continue;
        const vecLocal = allocLocal(fctx, `__super_spread_vec_${fctx.locals.length}`, vecType);
        fctx.body.push({ op: "local.set", index: vecLocal });
        const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecType.typeIdx);
        if (arrTypeIdx < 0) continue;
        const dataLocal = allocLocal(fctx, `__super_spread_data_${fctx.locals.length}`, {
          kind: "ref_null",
          typeIdx: arrTypeIdx,
        });
        fctx.body.push({ op: "local.get", index: vecLocal });
        fctx.body.push({ op: "struct.get", typeIdx: vecType.typeIdx, fieldIdx: 1 });
        fctx.body.push({ op: "local.set", index: dataLocal });
        const arrDefSpread = ctx.mod.types[arrTypeIdx];
        const spreadElemType =
          arrDefSpread && arrDefSpread.kind === "array" ? arrDefSpread.element : { kind: "f64" as const };
        const remaining = assignableParentFields.length - fieldIdx2;
        for (let i = 0; i < remaining; i++) {
          const { fieldIdx } = assignableParentFields[fieldIdx2]!;
          fctx.body.push({ op: "local.get", index: selfLocal });
          fctx.body.push({ op: "local.get", index: dataLocal });
          fctx.body.push({ op: "i32.const", value: i });
          emitBoundsCheckedArrayGet(fctx, arrTypeIdx, spreadElemType);
          fctx.body.push({ op: "struct.set", typeIdx: structTypeIdx, fieldIdx });
          fieldIdx2++;
        }
      } else {
        if (fieldIdx2 < assignableParentFields.length) {
          const { field, fieldIdx } = assignableParentFields[fieldIdx2]!;
          fctx.body.push({ op: "local.get", index: selfLocal });
          compileExpression(ctx, fctx, arg, field.type);
          fctx.body.push({ op: "struct.set", typeIdx: structTypeIdx, fieldIdx });
          fieldIdx2++;
        }
      }
    }
  } else {
    for (let i = 0; i < callExpr.arguments.length && i < assignableParentFields.length; i++) {
      const { field, fieldIdx } = assignableParentFields[i]!;
      fctx.body.push({ op: "local.get", index: selfLocal });
      compileExpression(ctx, fctx, callExpr.arguments[i]!, field.type);
      fctx.body.push({ op: "struct.set", typeIdx: structTypeIdx, fieldIdx });
    }
  }
}
