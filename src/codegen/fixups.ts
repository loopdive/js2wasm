/**
 * Post-compilation fixup passes.
 *
 * These functions operate on a completed WasmModule (or CodegenContext) and
 * repair type mismatches, fill in missing struct.new arguments, coerce
 * extern.convert_any operands, and mark leaf structs as final.
 *
 * Extracted from index.ts to keep index.ts focused on compilation orchestration.
 */

import type { FuncTypeDef, Instr, ValType, WasmFunction, WasmModule } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";

/**
 * Post-processing pass: mark leaf struct types in subtype hierarchies as final.
 *
 * V8 can devirtualize struct.get/struct.set when a type is known to be final
 * (no subtypes). Struct types without superTypeIdx are already implicitly final
 * in the Wasm binary encoding. This pass finds struct types that participate in
 * subtyping (have superTypeIdx set) but are never referenced as a parent by any
 * other type, and marks them as final so the emitter uses sub_final (0x4F).
 */
export function markLeafStructsFinal(mod: WasmModule): void {
  // Collect all type indices that are used as a supertype
  const hasSubtypes = new Set<number>();

  for (let i = 0; i < mod.types.length; i++) {
    const td = mod.types[i];
    if (td.kind === "struct" && td.superTypeIdx !== undefined && td.superTypeIdx >= 0) {
      hasSubtypes.add(td.superTypeIdx);
    } else if (td.kind === "rec") {
      for (const inner of td.types) {
        if (inner.kind === "struct" && inner.superTypeIdx !== undefined && inner.superTypeIdx >= 0) {
          hasSubtypes.add(inner.superTypeIdx);
        } else if (inner.kind === "sub" && inner.superType !== null && inner.superType >= 0) {
          hasSubtypes.add(inner.superType);
        }
      }
    } else if (td.kind === "sub" && td.superType !== null && td.superType >= 0) {
      hasSubtypes.add(td.superType);
    }
  }

  // Mark leaf struct types as final
  for (let i = 0; i < mod.types.length; i++) {
    const td = mod.types[i];
    if (td.kind === "struct" && td.superTypeIdx !== undefined && !hasSubtypes.has(i)) {
      td.final = true;
    } else if (td.kind === "rec") {
      // Types inside rec groups have their own indices (rec groups occupy consecutive indices)
      // We need to compute the base index for types within the rec group
      // Actually, rec group members are indexed consecutively starting at i
      let innerIdx = i;
      for (const inner of td.types) {
        if (inner.kind === "struct" && inner.superTypeIdx !== undefined && !hasSubtypes.has(innerIdx)) {
          inner.final = true;
        }
        innerIdx++;
      }
    }
  }
}

/**
 * Post-processing pass: repair struct.get/struct.set type mismatches.
 *
 * When code generation emits ref.null.extern or local.get of an externref local
 * immediately before a struct.get/struct.set, Wasm validation fails because
 * struct.get/struct.set require a reference to the specific struct type.
 *
 * This pass fixes two patterns:
 *
 * 1. ref.null.extern + struct.get/struct.set → ref.null $typeIdx
 *    (null externref replaced with typed null for the expected struct type)
 *
 * 2. local.get $externref + struct.get/struct.set → local.get + any.convert_extern + ref.cast $typeIdx
 *    (externref converted to the expected struct reference type)
 *
 * 3. call returning externref + struct.get/struct.set → call + any.convert_extern + ref.cast $typeIdx
 *
 * Recurses into nested blocks, loops, if/then/else, and try/catch bodies.
 */
export function repairStructTypeMismatches(mod: WasmModule): number {
  let totalFixed = 0;

  for (const func of mod.functions) {
    // Build local type map: params from func type, then locals
    const funcType = mod.types[func.typeIdx];
    const paramTypes: ValType[] = funcType && funcType.kind === "func" ? funcType.params : [];
    const localTypes: ValType[] = [...paramTypes, ...func.locals.map((l) => l.type)];

    totalFixed += repairBody(func.body, localTypes, mod);
  }

  return totalFixed;
}

export function repairBody(body: Instr[], localTypes: ValType[], mod: WasmModule): number {
  let fixed = 0;

  // Recurse into nested blocks first
  for (const instr of body) {
    switch (instr.op) {
      case "block":
      case "loop":
        if (instr.body) fixed += repairBody(instr.body, localTypes, mod);
        break;
      case "if":
        if (instr.then) fixed += repairBody(instr.then, localTypes, mod);
        if (instr.else) fixed += repairBody(instr.else, localTypes, mod);
        break;
      case "try":
        if (instr.body) fixed += repairBody(instr.body as Instr[], localTypes, mod);
        if ((instr as any).catches) {
          for (const c of (instr as any).catches) {
            if (c.body) fixed += repairBody(c.body, localTypes, mod);
          }
        }
        break;
    }
  }

  // Scan for struct.get preceded by externref-producing instructions
  let i = 0;
  while (i < body.length - 1) {
    const next = body[i + 1]!;
    if (next.op !== "struct.get") {
      i++;
      continue;
    }
    const structTypeIdx = (next as { typeIdx: number }).typeIdx;
    const curr = body[i]!;

    // Pattern 1: ref.null.extern → ref.null $typeIdx
    if (curr.op === "ref.null.extern") {
      body[i] = { op: "ref.null", typeIdx: structTypeIdx } as Instr;
      fixed++;
      i += 2;
      continue;
    }

    // Pattern 2: local.get of externref → insert any.convert_extern + ref.cast
    if (curr.op === "local.get") {
      const idx = (curr as { index: number }).index;
      const localType = localTypes[idx];
      if (localType && localType.kind === "externref") {
        body.splice(
          i + 1,
          0,
          { op: "any.convert_extern" } as unknown as Instr,
          { op: "ref.cast_null", typeIdx: structTypeIdx } as unknown as Instr,
        );
        fixed++;
        i += 4; // skip past local.get + any.convert_extern + ref.cast_null + struct.get
        continue;
      }
    }

    // Pattern 2b: local.tee of externref → insert any.convert_extern + ref.cast
    if (curr.op === "local.tee") {
      const idx = (curr as { index: number }).index;
      const localType = localTypes[idx];
      if (localType && localType.kind === "externref") {
        body.splice(
          i + 1,
          0,
          { op: "any.convert_extern" } as unknown as Instr,
          { op: "ref.cast_null", typeIdx: structTypeIdx } as unknown as Instr,
        );
        fixed++;
        i += 4;
        continue;
      }
    }

    // Pattern 3: call returning externref → insert any.convert_extern + ref.cast
    // Check the function's return type; if it's externref but struct.get needs
    // a struct ref, insert a conversion.
    if (curr.op === "call") {
      const funcIdx = (curr as { funcIdx: number }).funcIdx;
      const numImports = mod.imports.filter((imp) => imp.desc.kind === "func").length;
      let retType: ValType | undefined;
      if (funcIdx < numImports) {
        const imp = mod.imports.filter((imp) => imp.desc.kind === "func")[funcIdx];
        const ft = imp ? mod.types[(imp.desc as { typeIdx: number }).typeIdx] : undefined;
        if (ft?.kind === "func" && ft.results.length > 0) retType = ft.results[0];
      } else {
        const fn = mod.functions[funcIdx - numImports];
        const ft = fn ? mod.types[fn.typeIdx] : undefined;
        if (ft?.kind === "func" && ft.results.length > 0) retType = ft.results[0];
      }
      if (retType && retType.kind === "externref") {
        body.splice(
          i + 1,
          0,
          { op: "any.convert_extern" } as unknown as Instr,
          { op: "ref.cast_null", typeIdx: structTypeIdx } as unknown as Instr,
        );
        fixed++;
        i += 4;
        continue;
      }
    }

    i++;
  }

  // Scan for struct.set preceded by externref-producing instructions.
  // struct.set pops [struct_ref, value] — we need to find the instruction that
  // produces the struct ref by tracking stack depth backwards from the struct.set.
  i = 0;
  while (i < body.length) {
    const instr = body[i]!;
    if (instr.op !== "struct.set") {
      i++;
      continue;
    }
    const structTypeIdx = (instr as { typeIdx: number }).typeIdx;

    // Walk backwards to find the struct ref producer.
    // struct.set consumes 2 values: the struct ref (deeper) and the field value (top).
    // Track net stack contribution going backwards: when cumulative reaches +2,
    // that instruction produced the struct ref.
    let depth = 0;
    let refIdx = -1;
    for (let j = i - 1; j >= 0; j--) {
      depth += instrStackDelta(body[j]!, mod);
      if (depth >= 2) {
        refIdx = j;
        break;
      }
    }

    if (refIdx >= 0) {
      const refProducer = body[refIdx]!;

      // Pattern: ref.null.extern → ref.null $typeIdx
      if (refProducer.op === "ref.null.extern") {
        body[refIdx] = { op: "ref.null", typeIdx: structTypeIdx } as Instr;
        fixed++;
        i++;
        continue;
      }

      // Pattern: local.get $externref → insert any.convert_extern + ref.cast_null
      if (refProducer.op === "local.get" || refProducer.op === "local.tee") {
        const idx = (refProducer as { index: number }).index;
        const localType = localTypes[idx];
        if (localType && localType.kind === "externref") {
          body.splice(
            refIdx + 1,
            0,
            { op: "any.convert_extern" } as unknown as Instr,
            { op: "ref.cast_null", typeIdx: structTypeIdx } as unknown as Instr,
          );
          fixed++;
          i += 3; // shifted by 2 insertions + advance past struct.set
          continue;
        }
      }
    }

    i++;
  }

  return fixed;
}

/**
 * Compute the net stack delta for a single instruction.
 * Returns (values_pushed - values_consumed). Used by repairStructTypeMismatches
 * to walk backwards and find the instruction that produces a specific stack value.
 *
 * This is a conservative approximation — block/loop/if/try are treated as opaque
 * (delta 0), which is safe because struct.get/struct.set operands are almost never
 * produced by branching constructs.
 */
export function instrStackDelta(instr: Instr, mod: WasmModule): number {
  switch (instr.op) {
    // Push 1 value, consume 0
    case "local.get":
    case "global.get":
    case "i32.const":
    case "i64.const":
    case "f64.const":
    case "f32.const":
    case "ref.null":
    case "ref.null.extern":
    case "ref.null.eq":
    case "ref.null.func":
    case "ref.func":
    case "memory.size":
      return 1;

    // Push 1, consume 1 (net 0)
    case "local.tee":
    case "ref.as_non_null":
    case "ref.cast":
    case "ref.cast_null":
    case "ref.test":
    case "ref.is_null":
    case "any.convert_extern":
    case "extern.convert_any":
    case "i32.eqz":
    case "i64.eqz":
    case "i32.clz":
    case "f64.abs":
    case "f64.neg":
    case "f64.floor":
    case "f64.ceil":
    case "f64.trunc":
    case "f64.nearest":
    case "f64.sqrt":
    case "f64.convert_i32_s":
    case "f64.convert_i32_u":
    case "f64.convert_i64_s":
    case "i32.trunc_f64_s":
    case "i32.trunc_f64_u":
    case "i32.trunc_sat_f64_s":
    case "i32.trunc_sat_f64_u":
    case "i64.trunc_sat_f64_s":
    case "i64.extend_i32_s":
    case "i64.extend_i32_u":
    case "i64.trunc_f64_s":
    case "array.len":
    case "f64.promote_f32":
    case "f64.reinterpret_i64":
    case "i64.reinterpret_f64":
      return 0;

    // Push 0, consume 1
    case "drop":
    case "local.set":
    case "global.set":
    case "br_if":
      return -1;

    // Push 1, consume 2 (net -1)
    case "i32.add":
    case "i32.sub":
    case "i32.mul":
    case "i32.eq":
    case "i32.ne":
    case "i32.lt_s":
    case "i32.le_s":
    case "i32.gt_s":
    case "i32.ge_s":
    case "i32.ge_u":
    case "i32.and":
    case "i32.or":
    case "i32.xor":
    case "i32.shl":
    case "i32.shr_s":
    case "i32.shr_u":
    case "i64.add":
    case "i64.sub":
    case "i64.mul":
    case "i64.div_s":
    case "i64.rem_s":
    case "i64.eq":
    case "i64.ne":
    case "i64.lt_s":
    case "i64.le_s":
    case "i64.gt_s":
    case "i64.ge_s":
    case "i64.and":
    case "i64.or":
    case "i64.xor":
    case "i64.shl":
    case "i64.shr_s":
    case "i64.shr_u":
    case "f64.add":
    case "f64.sub":
    case "f64.mul":
    case "f64.div":
    case "f64.eq":
    case "f64.ne":
    case "f64.lt":
    case "f64.le":
    case "f64.gt":
    case "f64.ge":
    case "f64.copysign":
    case "f64.min":
    case "f64.max":
    case "ref.eq":
      return -1;

    // Push 1, consume 3 (net -2)
    case "select":
      return -2;

    // struct.new: consumes N fields, pushes 1 struct ref
    case "struct.new": {
      const typeIdx = (instr as { typeIdx: number }).typeIdx;
      const typeDef = mod.types[typeIdx];
      const fieldCount = typeDef?.kind === "struct" ? typeDef.fields.length : 0;
      return 1 - fieldCount;
    }

    // struct.get: consume 1 (struct ref), push 1 (field value) — net 0
    case "struct.get":
      return 0;

    // struct.set: consume 2 (struct ref + value), push 0 — net -2
    case "struct.set":
      return -2;

    // array operations
    case "array.get":
    case "array.get_s":
    case "array.get_u":
      return -1; // consume arr + idx, push value
    case "array.set":
      return -3; // consume arr + idx + value
    case "array.new":
    case "array.new_default":
      return 0; // consume length, push array (net 0)
    case "array.new_fixed": {
      const len = (instr as { length: number }).length;
      return 1 - len;
    }

    // call: consumes params, pushes results
    case "call": {
      const funcIdx = (instr as { funcIdx: number }).funcIdx;
      // Look up function type
      const numImports = mod.imports.filter((imp) => imp.desc.kind === "func").length;
      let typeIdx: number;
      if (funcIdx < numImports) {
        const imp = mod.imports.filter((imp) => imp.desc.kind === "func")[funcIdx];
        typeIdx = imp ? (imp.desc as { typeIdx: number }).typeIdx : -1;
      } else {
        const fn = mod.functions[funcIdx - numImports];
        typeIdx = fn?.typeIdx ?? -1;
      }
      const ft = typeIdx >= 0 ? mod.types[typeIdx] : undefined;
      if (ft?.kind === "func") {
        return ft.results.length - ft.params.length;
      }
      return 0;
    }
    case "call_ref":
    case "return_call":
    case "return_call_ref":
    case "call_indirect":
      return 0; // conservative: unknown effect

    // Control flow — opaque
    case "block":
    case "loop":
    case "if":
    case "try":
      return 0;

    // Terminal
    case "return":
    case "br":
    case "unreachable":
    case "throw":
      return 0;

    case "nop":
      return 0;

    default:
      return 0; // conservative default
  }
}

/**
 * Post-compilation fixup: reconcile struct.new argument counts.
 *
 * During expression compilation, fields can be dynamically added to struct
 * types (e.g., when a property access finds a field the TS type checker knows
 * about but wasn't in the original struct definition). This causes the
 * struct type to have more fields than the constructor's struct.new pushes
 * values for, resulting in Wasm validation failure.
 *
 * This pass scans all function bodies for struct.new instructions on class
 * struct types and inserts default-value instructions for any missing fields.
 */
export function fixupStructNewArgCounts(ctx: CodegenContext): void {
  // Build a reverse map: typeIdx -> className
  const typeIdxToClass = new Map<number, string>();
  for (const [className, typeIdx] of ctx.structMap.entries()) {
    if (ctx.classSet.has(className)) {
      typeIdxToClass.set(typeIdx, className);
    }
  }
  if (typeIdxToClass.size === 0) return;

  // Helper: generate default value instructions for a field type
  function defaultInstrForType(type: ValType): Instr[] {
    switch (type.kind) {
      case "f64":
        return [{ op: "f64.const", value: 0 }];
      case "i32":
        return [{ op: "i32.const", value: 0 }];
      case "externref":
        return [{ op: "ref.null.extern" }];
      case "ref":
        return [{ op: "ref.null", typeIdx: (type as { typeIdx: number }).typeIdx }, { op: "ref.as_non_null" } as Instr];
      case "ref_null":
        return [{ op: "ref.null", typeIdx: (type as { typeIdx: number }).typeIdx }];
      default:
        if ((type as any).kind === "i64") {
          return [{ op: "i64.const", value: 0n }];
        }
        if ((type as any).kind === "eqref") {
          return [{ op: "ref.null.eq" }];
        }
        return [{ op: "i32.const", value: 0 }];
    }
  }

  // Scan all functions for struct.new instructions that need fixup
  function fixupInstrs(instrs: Instr[]): void {
    for (let i = 0; i < instrs.length; i++) {
      const instr = instrs[i]!;

      // Recurse into nested instruction arrays
      if ("body" in instr && Array.isArray((instr as any).body)) {
        fixupInstrs((instr as any).body);
      }
      if ("then" in instr && Array.isArray((instr as any).then)) {
        fixupInstrs((instr as any).then);
      }
      if ("else" in instr && Array.isArray((instr as any).else)) {
        fixupInstrs((instr as any).else);
      }
      if ("catches" in instr && Array.isArray((instr as any).catches)) {
        for (const c of (instr as any).catches) {
          if (Array.isArray(c.body)) fixupInstrs(c.body);
        }
      }
      if ("catchAll" in instr && Array.isArray((instr as any).catchAll)) {
        fixupInstrs((instr as any).catchAll);
      }

      if (instr.op !== "struct.new") continue;
      const typeIdx = (instr as { typeIdx: number }).typeIdx;
      const typeDef = ctx.mod.types[typeIdx];
      if (!typeDef || typeDef.kind !== "struct") continue;

      // Only fix class struct types (not vec/closure/string structs)
      const className = typeIdxToClass.get(typeIdx);
      if (!className) continue;

      const expectedFieldCount = typeDef.fields.length;
      const fields = ctx.structFields.get(className);
      if (!fields) continue;

      // The fields array should match typeDef.fields (they share a reference
      // or were independently grown). Use typeDef as the source of truth.
      // Count backwards from struct.new to find how many default-value
      // instructions were pushed. We look for a contiguous run of
      // const/ref.null/ref.as_non_null ops.
      let pushedCount = 0;
      let j = i - 1;
      while (j >= 0) {
        const prev = instrs[j]!;
        const op = prev.op;
        if (
          op === "f64.const" ||
          op === "i32.const" ||
          op === "i64.const" ||
          op === "ref.null" ||
          op === "ref.null.extern" ||
          op === "ref.null.eq" ||
          op === "ref.as_non_null"
        ) {
          // ref.as_non_null doesn't push a new value, it converts the top.
          // Don't count it as a separate pushed value.
          if (op !== "ref.as_non_null") {
            pushedCount++;
          }
          j--;
        } else {
          break;
        }
      }

      if (pushedCount < expectedFieldCount && pushedCount > 0) {
        // Only fix if we found SOME defaults (confirming this is a constructor
        // struct.new pattern, not some other struct.new usage)
        const newInstrs: Instr[] = [];
        for (let k = pushedCount; k < expectedFieldCount; k++) {
          const field = typeDef.fields[k]!;
          if (field.name === "__tag") {
            const tagValue = ctx.classTagMap.get(className) ?? 0;
            newInstrs.push({ op: "i32.const", value: tagValue });
          } else {
            newInstrs.push(...defaultInstrForType(field.type));
          }
        }
        // Insert missing field defaults right before struct.new
        instrs.splice(i, 0, ...newInstrs);
        // Adjust loop index since we inserted instructions
        i += newInstrs.length;
      }
    }
  }

  // Only scan constructor functions and Object.create paths
  for (const func of ctx.mod.functions) {
    if (func.body.length > 0) {
      fixupInstrs(func.body);
    }
  }
}

export function fixupStructNewResultCoercion(ctx: CodegenContext): void {
  function getLocalType(func: WasmFunction, localIdx: number): ValType | null {
    const funcType = ctx.mod.types[func.typeIdx];
    if (!funcType || funcType.kind !== "func") return null;
    const ft = funcType as FuncTypeDef;
    if (localIdx < ft.params.length) {
      return ft.params[localIdx]!;
    }
    const bodyLocalIdx = localIdx - ft.params.length;
    if (bodyLocalIdx < func.locals.length) {
      return func.locals[bodyLocalIdx]!.type;
    }
    return null;
  }

  function fixupInstrs(func: WasmFunction, instrs: Instr[]): void {
    for (let i = 0; i < instrs.length; i++) {
      const instr = instrs[i]!;

      // Recurse into nested instruction arrays
      if ("body" in instr && Array.isArray((instr as any).body)) {
        fixupInstrs(func, (instr as any).body);
      }
      if ("then" in instr && Array.isArray((instr as any).then)) {
        fixupInstrs(func, (instr as any).then);
      }
      if ("else" in instr && Array.isArray((instr as any).else)) {
        fixupInstrs(func, (instr as any).else);
      }
      if ("catches" in instr && Array.isArray((instr as any).catches)) {
        for (const c of (instr as any).catches) {
          if (Array.isArray(c.body)) fixupInstrs(func, c.body);
        }
      }
      if ("catchAll" in instr && Array.isArray((instr as any).catchAll)) {
        fixupInstrs(func, (instr as any).catchAll);
      }

      // Fix array.new_default: length must be i32, not externref
      if (instr.op === "array.new_default" && i > 0) {
        const prev = instrs[i - 1]!;
        if (prev.op === "ref.null.extern") {
          instrs[i - 1] = { op: "i32.const", value: 0 } as Instr;
        } else {
          let isExternref = false;
          if (prev.op === "local.get") {
            const lt = getLocalType(func, (prev as { index: number }).index);
            if (lt && lt.kind === "externref") isExternref = true;
          } else if (prev.op === "global.get") {
            const gIdx = (prev as { index: number }).index;
            const gDef = ctx.mod.globals[gIdx];
            if (gDef && gDef.type.kind === "externref") isExternref = true;
          }
          if (isExternref) {
            const unboxIdx = ctx.funcMap.get("__unbox_number");
            if (unboxIdx !== undefined) {
              instrs.splice(i, 0, { op: "call", funcIdx: unboxIdx } as Instr, { op: "i32.trunc_sat_f64_s" } as Instr);
              i += 2;
            } else {
              instrs[i - 1] = { op: "i32.const", value: 0 } as Instr;
            }
          }
        }
      }

      if (instr.op !== "struct.new") continue;
      const typeIdx = (instr as { typeIdx: number }).typeIdx;
      const typeDef = ctx.mod.types[typeIdx];

      // Fix struct.new arguments: if a field expects externref but the
      // preceding instruction produces a ref/ref_null, insert extern.convert_any
      // struct.new field argument coercion is now handled by
      // stack-balance.ts fixCallArgTypesInBody (struct.new loop).

      // Check what consumes the struct.new result
      const next = instrs[i + 1];
      if (!next) continue;

      if (next.op === "local.set" || next.op === "local.tee") {
        const localIdx = (next as { index: number }).index;
        const localType = getLocalType(func, localIdx);
        if (localType && localType.kind === "externref") {
          // Insert extern.convert_any between struct.new and local.set/tee
          instrs.splice(i + 1, 0, { op: "extern.convert_any" } as Instr);
          i++; // skip the inserted instruction
        }
      } else if (next.op === "global.set") {
        // Check global type
        const globalIdx = (next as { index: number }).index;
        const globalDef = ctx.mod.globals[globalIdx];
        if (globalDef && globalDef.type.kind === "externref") {
          instrs.splice(i + 1, 0, { op: "extern.convert_any" } as Instr);
          i++;
        }
      }
    }

    // Peephole: fix extern.convert_any applied to non-anyref values.
    // extern.convert_any expects anyref input. Remove if input is already externref,
    // or replace with drop+ref.null.extern if input is funcref (separate hierarchy).
    for (let j = instrs.length - 1; j > 0; j--) {
      if (instrs[j]!.op === "extern.convert_any") {
        const prev = instrs[j - 1]!;
        let isAlreadyExternref = false;
        let isFuncref = false;
        if (prev.op === "extern.convert_any") {
          isAlreadyExternref = true;
        } else if (prev.op === "ref.null.extern") {
          isAlreadyExternref = true;
        } else if (prev.op === "ref.func") {
          isFuncref = true;
        } else if (prev.op === "local.get") {
          const lt = getLocalType(func, (prev as { index: number }).index);
          if (lt && lt.kind === "externref") isAlreadyExternref = true;
          if (lt && lt.kind === "funcref") isFuncref = true;
        } else if (prev.op === "global.get") {
          const gIdx = (prev as { index: number }).index;
          const gDef = ctx.mod.globals[gIdx];
          if (gDef && gDef.type.kind === "externref") isAlreadyExternref = true;
          if (gDef && gDef.type.kind === "funcref") isFuncref = true;
        } else if (prev.op === "struct.get") {
          // struct.get can produce funcref fields — check the struct type
          const sTypeIdx = (prev as any).typeIdx;
          const sFieldIdx = (prev as any).fieldIdx;
          const sDef = ctx.mod.types[sTypeIdx];
          if (sDef && sDef.kind === "struct") {
            const sField = (sDef as any).fields[sFieldIdx];
            if (sField) {
              const ft = sField.type;
              if (ft.kind === "funcref") isFuncref = true;
            }
          }
        } else if (prev.op === "ref.cast" || prev.op === "ref.cast_null") {
          // ref.cast to a func type produces funcref, not anyref
          const castTypeIdx = (prev as any).typeIdx;
          const castDef = ctx.mod.types[castTypeIdx];
          if (castDef && castDef.kind === "func") isFuncref = true;
        }
        if (isAlreadyExternref || isFuncref) {
          // Remove invalid extern.convert_any (already externref, or funcref which is not anyref)
          instrs.splice(j, 1);
        }
      }
    }
  }

  for (const func of ctx.mod.functions) {
    if (func.body.length > 0) {
      fixupInstrs(func, func.body);
    }
  }
}

/**
 * Late-stage fixup: repair extern.convert_any applied to non-anyref values.
 * extern.convert_any expects anyref input, but various passes can produce
 * extern.convert_any on externref (redundant) or funcref (invalid — separate hierarchy).
 * Must run after ALL other codegen/fixup passes.
 */
export function fixupExternConvertAny(ctx: CodegenContext): void {
  function getLocalType(func: WasmFunction, localIdx: number): ValType | null {
    const funcType = ctx.mod.types[func.typeIdx];
    if (!funcType || funcType.kind !== "func") return null;
    const ft = funcType as FuncTypeDef;
    if (localIdx < ft.params.length) return ft.params[localIdx]!;
    const bodyLocalIdx = localIdx - ft.params.length;
    if (bodyLocalIdx < func.locals.length) return func.locals[bodyLocalIdx]!.type;
    return null;
  }

  function fixupInstrs(func: WasmFunction, instrs: Instr[]): void {
    // Recurse into nested blocks first
    for (const instr of instrs) {
      if ("body" in instr && Array.isArray((instr as any).body)) {
        fixupInstrs(func, (instr as any).body);
      }
      if ("then" in instr && Array.isArray((instr as any).then)) {
        fixupInstrs(func, (instr as any).then);
      }
      if ("else" in instr && Array.isArray((instr as any).else)) {
        fixupInstrs(func, (instr as any).else);
      }
      if ("catches" in instr && Array.isArray((instr as any).catches)) {
        for (const c of (instr as any).catches) {
          if (Array.isArray(c.body)) fixupInstrs(func, c.body);
        }
      }
      if ("catchAll" in instr && Array.isArray((instr as any).catchAll)) {
        fixupInstrs(func, (instr as any).catchAll);
      }
    }

    // Scan for extern.convert_any with non-anyref inputs
    for (let j = instrs.length - 1; j > 0; j--) {
      if (instrs[j]!.op !== "extern.convert_any") continue;
      const prev = instrs[j - 1]!;
      let isAlreadyExternref = false;
      let isFuncref = false;

      if (prev.op === "extern.convert_any") {
        isAlreadyExternref = true;
      } else if (prev.op === "ref.null.extern") {
        isAlreadyExternref = true;
      } else if (prev.op === "ref.func") {
        isFuncref = true;
      } else if (prev.op === "local.get") {
        const lt = getLocalType(func, (prev as { index: number }).index);
        if (lt && lt.kind === "externref") isAlreadyExternref = true;
        if (lt && lt.kind === "funcref") isFuncref = true;
        // Check if the local's type references a func type (e.g., (ref null $func_type))
        if (lt && (lt.kind === "ref" || lt.kind === "ref_null") && (lt as any).typeIdx !== undefined) {
          const refDef = ctx.mod.types[(lt as any).typeIdx];
          if (refDef && refDef.kind === "func") isFuncref = true;
        }
      } else if (prev.op === "global.get") {
        const gIdx = (prev as { index: number }).index;
        const gDef = ctx.mod.globals[gIdx];
        if (gDef && gDef.type.kind === "externref") isAlreadyExternref = true;
        if (gDef && gDef.type.kind === "funcref") isFuncref = true;
        // Also check globals with externref type
        if (gDef && (gDef.type.kind === "externref" || gDef.type.kind === "ref_extern")) isAlreadyExternref = true;
      } else if (prev.op === "struct.get") {
        const sTypeIdx = (prev as any).typeIdx;
        const sFieldIdx = (prev as any).fieldIdx;
        const sDef = ctx.mod.types[sTypeIdx];
        if (sDef && sDef.kind === "struct") {
          const sField = (sDef as any).fields[sFieldIdx];
          if (sField && sField.type.kind === "funcref") isFuncref = true;
        }
      } else if (prev.op === "ref.cast" || prev.op === "ref.cast_null") {
        const castTypeIdx = (prev as any).typeIdx;
        const castDef = ctx.mod.types[castTypeIdx];
        if (castDef && castDef.kind === "func") isFuncref = true;
      }

      if (isAlreadyExternref || isFuncref) {
        // For externref: remove redundant extern.convert_any (already externref)
        // For funcref: remove invalid extern.convert_any (funcref is not subtype of anyref)
        instrs.splice(j, 1);
      }
    }

    // Fix extern.convert_any consumed by struct.new for non-externref fields.
    // If extern.convert_any + struct.new where the field at that position expects
    // a ref/ref_null type, replace extern.convert_any with the correct coercion.
    for (let j = 0; j < instrs.length - 1; j++) {
      if (instrs[j]!.op !== "extern.convert_any") continue;
      const next = instrs[j + 1]!;
      if (next.op !== "struct.new") continue;

      const snTypeIdx = (next as any).typeIdx as number;
      const snTypeDef = ctx.mod.types[snTypeIdx];
      if (!snTypeDef || snTypeDef.kind !== "struct") continue;

      const fields = (snTypeDef as any).fields as Array<{ type: ValType }>;
      // The extern.convert_any is the last argument to struct.new, so it's for the last field
      const lastField = fields[fields.length - 1];
      if (!lastField) continue;

      if (lastField.type.kind === "ref" || lastField.type.kind === "ref_null") {
        // extern.convert_any produces externref but field expects (ref null N).
        // Replace with nothing (remove extern.convert_any) — the ref type from before
        // is already correct for the struct field.
        instrs.splice(j, 1);
        j--; // re-check this position
      }
    }

    // Fix return_call/call: ref.null extern where (ref null N) is expected
    for (let j = 0; j < instrs.length; j++) {
      const instr = instrs[j]!;
      if (instr.op !== "return_call" && instr.op !== "call") continue;
      const funcIdx = (instr as any).funcIdx;
      if (funcIdx === undefined) continue;

      // Get the target function's param types
      const totalImports = ctx.mod.imports.filter((imp: any) => imp.desc?.kind === "func").length;
      let targetTypeIdx: number | undefined;
      if (funcIdx < totalImports) {
        // It's an import
        let importIdx = 0;
        for (const imp of ctx.mod.imports) {
          if ((imp as any).desc?.kind === "func") {
            if (importIdx === funcIdx) {
              targetTypeIdx = (imp as any).desc.typeIdx;
              break;
            }
            importIdx++;
          }
        }
      } else {
        const localFuncIdx = funcIdx - totalImports;
        const targetFunc = ctx.mod.functions[localFuncIdx];
        if (targetFunc) targetTypeIdx = targetFunc.typeIdx;
      }
      if (targetTypeIdx === undefined) continue;
      const targetType = ctx.mod.types[targetTypeIdx];
      if (!targetType || targetType.kind !== "func") continue;
      const params = (targetType as FuncTypeDef).params;

      // Walk backwards to find ref.null extern args that should be ref.null for (ref null N).
      // Must account for multi-consuming instructions like struct.new that eat
      // their own arguments from the stack — their consumed args are NOT call args.
      let pos = j;
      for (let pi = params.length - 1; pi >= 0; pi--) {
        pos--;
        if (pos < 0) break;
        const argInstr = instrs[pos]!;

        // struct.new consumes N fields and produces 1 value.
        // The current pos IS a call arg (the struct.new result), but the N
        // instructions before it are struct field args, NOT call args.
        // Skip over them so the next iteration's pos-- lands correctly.
        if (argInstr.op === "struct.new") {
          const snTypeIdx = (argInstr as any).typeIdx as number;
          const snTypeDef = ctx.mod.types[snTypeIdx];
          if (snTypeDef && snTypeDef.kind === "struct") {
            const numFields = (snTypeDef as any).fields.length;
            pos -= numFields; // skip past the field-producing instructions
          }
          continue; // struct.new itself doesn't need ref.null fixup
        }
        // array.new_fixed similarly consumes N elements
        if (argInstr.op === "array.new_fixed") {
          const size = (argInstr as any).size ?? 0;
          pos -= size;
          continue;
        }
        // call consumes M args and produces 1 value — skip its args
        if (argInstr.op === "call" || argInstr.op === "return_call") {
          const callFuncIdx = (argInstr as any).funcIdx;
          if (callFuncIdx !== undefined) {
            const callTotalImports = ctx.mod.imports.filter((imp: any) => imp.desc?.kind === "func").length;
            let callTargetTypeIdx: number | undefined;
            if (callFuncIdx < callTotalImports) {
              let ci = 0;
              for (const imp of ctx.mod.imports) {
                if ((imp as any).desc?.kind === "func") {
                  if (ci === callFuncIdx) {
                    callTargetTypeIdx = (imp as any).desc.typeIdx;
                    break;
                  }
                  ci++;
                }
              }
            } else {
              const f = ctx.mod.functions[callFuncIdx - callTotalImports];
              if (f) callTargetTypeIdx = f.typeIdx;
            }
            if (callTargetTypeIdx !== undefined) {
              const callFt = ctx.mod.types[callTargetTypeIdx];
              if (callFt && callFt.kind === "func") {
                pos -= (callFt as FuncTypeDef).params.length;
              }
            }
          }
          continue;
        }

        const paramType = params[pi]!;
        if (argInstr.op === "ref.null.extern" && (paramType.kind === "ref" || paramType.kind === "ref_null")) {
          // Replace ref.null extern with ref.null of the correct type
          instrs[pos] = { op: "ref.null", typeIdx: (paramType as any).typeIdx } as unknown as Instr;
        }
      }
    }
  }

  for (const func of ctx.mod.functions) {
    if (func.body.length > 0) {
      fixupInstrs(func, func.body);
    }
  }
}
