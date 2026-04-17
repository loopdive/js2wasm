// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Dead import and type elimination pass.
 *
 * After codegen, the WasmModule may contain unused function imports and
 * type definitions that were speculatively registered (e.g. all wasm:js-string
 * ops are added when any string literal is present, even if only concat is used).
 *
 * This pass scans all function bodies, globals, exports, elements, and tags
 * to determine which function indices and type indices are actually referenced,
 * then removes the dead ones and remaps all surviving indices.
 */
import type { ArrayTypeDef, Instr, StructTypeDef, SubTypeDef, TypeDef, ValType, WasmModule } from "../ir/types.js";
import { walkInstructions } from "./walk-instructions.js";

// --- Reference collection ---

function collectRefsFromBody(body: Instr[], usedFuncs: Set<number>, usedTypes: Set<number>): void {
  for (const instr of body) {
    switch (instr.op) {
      case "call":
        usedFuncs.add(instr.funcIdx);
        break;
      case "ref.func":
        usedFuncs.add(instr.funcIdx);
        break;
      case "call_indirect":
        usedTypes.add(instr.typeIdx);
        break;
      case "call_ref":
        usedTypes.add(instr.typeIdx);
        break;
      case "struct.new":
      case "struct.get":
      case "struct.set":
        usedTypes.add(instr.typeIdx);
        break;
      case "array.new":
      case "array.new_fixed":
      case "array.new_default":
      case "array.get":
      case "array.get_s":
      case "array.get_u":
      case "array.set":
      case "array.fill":
        usedTypes.add(instr.typeIdx);
        break;
      case "array.copy":
        usedTypes.add(instr.dstTypeIdx);
        usedTypes.add(instr.srcTypeIdx);
        break;
      case "ref.null":
        if (typeof instr.typeIdx === "number") {
          usedTypes.add(instr.typeIdx);
        }
        break;
      case "ref.cast":
      case "ref.cast_null":
      case "ref.test":
        usedTypes.add(instr.typeIdx);
        break;
      case "block":
      case "loop":
        collectBlockTypeRefs(instr.blockType, usedTypes);
        collectRefsFromBody(instr.body, usedFuncs, usedTypes);
        break;
      case "if":
        collectBlockTypeRefs(instr.blockType, usedTypes);
        collectRefsFromBody(instr.then, usedFuncs, usedTypes);
        if (instr.else) collectRefsFromBody(instr.else, usedFuncs, usedTypes);
        break;
      case "try":
        collectBlockTypeRefs(instr.blockType, usedTypes);
        collectRefsFromBody(instr.body, usedFuncs, usedTypes);
        for (const c of instr.catches) collectRefsFromBody(c.body, usedFuncs, usedTypes);
        if (instr.catchAll) collectRefsFromBody(instr.catchAll, usedFuncs, usedTypes);
        break;
      default: {
        // Catch-all for instructions cast via `as unknown as Instr`
        const a = instr as any;
        if (typeof a.typeIdx === "number") usedTypes.add(a.typeIdx);
        if (typeof a.funcIdx === "number") usedFuncs.add(a.funcIdx);
        if (typeof a.dstTypeIdx === "number") usedTypes.add(a.dstTypeIdx);
        if (typeof a.srcTypeIdx === "number") usedTypes.add(a.srcTypeIdx);
        // Handle blockType on custom instructions
        if (a.blockType) collectBlockTypeRefs(a.blockType, usedTypes);
        break;
      }
    }
  }
}

function collectBlockTypeRefs(bt: { kind: string; typeIdx?: number; type?: ValType }, usedTypes: Set<number>): void {
  if (bt.kind === "type" && typeof bt.typeIdx === "number") {
    usedTypes.add(bt.typeIdx);
  }
  if (bt.kind === "val" && bt.type) {
    collectRefsFromValType(bt.type, usedTypes);
  }
}

function collectRefsFromValType(vt: ValType, used: Set<number>): void {
  if ((vt.kind === "ref" || vt.kind === "ref_null") && typeof (vt as any).typeIdx === "number") {
    used.add((vt as { typeIdx: number }).typeIdx);
  }
}

function collectRefsFromTypeDef(td: TypeDef, used: Set<number>): void {
  switch (td.kind) {
    case "func":
      for (const p of td.params) collectRefsFromValType(p, used);
      for (const r of td.results) collectRefsFromValType(r, used);
      break;
    case "struct":
      if (td.superTypeIdx !== undefined) used.add(td.superTypeIdx);
      for (const f of td.fields) collectRefsFromValType(f.type, used);
      break;
    case "array":
      collectRefsFromValType(td.element, used);
      break;
    case "rec":
      for (const inner of td.types) collectRefsFromTypeDef(inner, used);
      break;
    case "sub":
      if (td.superType !== null) used.add(td.superType);
      collectRefsFromTypeDef(td.type, used);
      break;
  }
}

// --- Remapping ---

function remapFuncIdxInBody(body: Instr[], remap: Map<number, number>): void {
  walkInstructions(body, (instr) => {
    const a = instr as any;
    if (typeof a.funcIdx === "number" && remap.has(a.funcIdx)) {
      a.funcIdx = remap.get(a.funcIdx)!;
    }
  });
}

function remapTypeIdxInBody(body: Instr[], remap: Map<number, number>): void {
  walkInstructions(body, (instr) => {
    const a = instr as any;
    if (typeof a.typeIdx === "number" && remap.has(a.typeIdx)) {
      a.typeIdx = remap.get(a.typeIdx)!;
    }
    if (typeof a.dstTypeIdx === "number" && remap.has(a.dstTypeIdx)) {
      a.dstTypeIdx = remap.get(a.dstTypeIdx)!;
    }
    if (typeof a.srcTypeIdx === "number" && remap.has(a.srcTypeIdx)) {
      a.srcTypeIdx = remap.get(a.srcTypeIdx)!;
    }
    // Remap blockType
    if (a.blockType) {
      if (a.blockType.kind === "type" && remap.has(a.blockType.typeIdx)) {
        a.blockType.typeIdx = remap.get(a.blockType.typeIdx)!;
      }
      if (a.blockType.kind === "val" && a.blockType.type) {
        a.blockType.type = remapVT(a.blockType.type, remap);
      }
    }
  });
}

function remapVT(vt: ValType, remap: Map<number, number>): ValType {
  if ((vt.kind === "ref" || vt.kind === "ref_null") && typeof (vt as any).typeIdx === "number") {
    const old = (vt as any).typeIdx as number;
    if (remap.has(old)) {
      return { ...vt, typeIdx: remap.get(old)! } as ValType;
    }
  }
  return vt;
}

function remapTD(td: TypeDef, remap: Map<number, number>): TypeDef {
  switch (td.kind) {
    case "func":
      return {
        ...td,
        params: td.params.map((p) => remapVT(p, remap)),
        results: td.results.map((r) => remapVT(r, remap)),
      };
    case "struct": {
      const r: StructTypeDef = {
        ...td,
        fields: td.fields.map((f) => ({ ...f, type: remapVT(f.type, remap) })),
      };
      if (td.superTypeIdx !== undefined && remap.has(td.superTypeIdx)) {
        r.superTypeIdx = remap.get(td.superTypeIdx)!;
      }
      return r;
    }
    case "array":
      return { ...td, element: remapVT(td.element, remap) };
    case "rec":
      return {
        ...td,
        types: td.types.map((t) => remapTD(t, remap)) as TypeDef[],
      };
    case "sub": {
      const r: SubTypeDef = {
        ...td,
        type: remapTD(td.type, remap) as StructTypeDef | ArrayTypeDef,
      };
      if (td.superType !== null && remap.has(td.superType)) {
        r.superType = remap.get(td.superType)!;
      }
      return r;
    }
  }
}

// --- Main elimination pass ---

/**
 * Eliminate dead (unreferenced) function imports and type definitions
 * from a compiled WasmModule. Mutates the module in place.
 */
export function eliminateDeadImports(mod: WasmModule): void {
  const numImpF = mod.imports.filter((i) => i.desc.kind === "func").length;
  const usedF = new Set<number>();
  const usedT = new Set<number>();

  // All local (non-import) functions are always reachable
  for (let i = 0; i < mod.functions.length; i++) {
    usedF.add(numImpF + i);
  }

  // Scan function bodies
  for (const func of mod.functions) {
    collectRefsFromBody(func.body, usedF, usedT);
    usedT.add(func.typeIdx);
    for (const l of func.locals) collectRefsFromValType(l.type, usedT);
  }

  // Scan global init expressions
  for (const g of mod.globals) {
    collectRefsFromBody(g.init, usedF, usedT);
    collectRefsFromValType(g.type, usedT);
  }

  // Scan element segments
  for (const el of mod.elements) {
    for (const fi of el.funcIndices) usedF.add(fi);
    collectRefsFromBody(el.offset, usedF, usedT);
  }

  // Scan exports
  for (const ex of mod.exports) {
    if (ex.desc.kind === "func") usedF.add(ex.desc.index);
  }

  // declaredFuncRefs
  for (const fi of mod.declaredFuncRefs) usedF.add(fi);

  // Tags reference types
  for (const tag of mod.tags) usedT.add(tag.typeIdx);

  // Non-func import descriptors reference types
  for (const imp of mod.imports) {
    if (imp.desc.kind === "tag") usedT.add(imp.desc.typeIdx);
    if (imp.desc.kind === "global") collectRefsFromValType(imp.desc.type, usedT);
  }

  // --- Phase 2: Determine dead function imports ---
  let fi2 = 0;
  const impFI: number[] = [];
  const deadF = new Set<number>();
  for (let i = 0; i < mod.imports.length; i++) {
    if (mod.imports[i]!.desc.kind === "func") {
      impFI.push(fi2);
      if (!usedF.has(fi2)) deadF.add(fi2);
      fi2++;
    } else {
      impFI.push(-1);
    }
  }

  // Mark type indices used by surviving func imports
  for (let i = 0; i < mod.imports.length; i++) {
    const imp = mod.imports[i]!;
    if (imp.desc.kind === "func" && !deadF.has(impFI[i]!)) {
      usedT.add(imp.desc.typeIdx);
    }
  }

  // --- Phase 3: Compute transitive type closure ---
  let chg = true;
  while (chg) {
    chg = false;
    for (const ti of [...usedT]) {
      const td = mod.types[ti];
      if (!td) continue;
      const b = usedT.size;
      collectRefsFromTypeDef(td, usedT);
      if (usedT.size > b) chg = true;
    }
  }

  // --- Phase 4: Build remap tables ---
  const fR = new Map<number, number>();
  if (deadF.size > 0) {
    let n = 0;
    for (let o = 0; o < numImpF + mod.functions.length; o++) {
      if (deadF.has(o)) continue;
      if (o !== n) fR.set(o, n);
      n++;
    }
  }

  const tR = new Map<number, number>();
  const surv: TypeDef[] = [];
  let rem = 0;
  {
    let n = 0;
    for (let o = 0; o < mod.types.length; o++) {
      if (!usedT.has(o)) {
        rem++;
        continue;
      }
      if (o !== n) tR.set(o, n);
      surv.push(mod.types[o]!);
      n++;
    }
  }

  if (fR.size === 0 && tR.size === 0 && deadF.size === 0 && rem === 0) {
    return;
  }

  // --- Phase 5: Apply remapping ---

  // Remove dead function imports
  if (deadF.size > 0) {
    let idx = 0;
    mod.imports = mod.imports.filter((imp) => {
      if (imp.desc.kind === "func") {
        const dead = deadF.has(idx);
        idx++;
        return !dead;
      }
      return true;
    });
  }

  // Replace types array
  if (rem > 0) {
    mod.types = surv.map((td) => (tR.size > 0 ? remapTD(td, tR) : td));
  }

  // Remap function bodies
  for (const func of mod.functions) {
    if (fR.size > 0) remapFuncIdxInBody(func.body, fR);
    if (tR.size > 0) remapTypeIdxInBody(func.body, tR);
    if (tR.has(func.typeIdx)) func.typeIdx = tR.get(func.typeIdx)!;
    if (tR.size > 0) {
      for (let i = 0; i < func.locals.length; i++) {
        func.locals[i] = {
          ...func.locals[i]!,
          type: remapVT(func.locals[i]!.type, tR),
        };
      }
    }
  }

  // Remap import descriptors
  for (const imp of mod.imports) {
    if (imp.desc.kind === "func" && tR.has(imp.desc.typeIdx)) {
      imp.desc = {
        ...imp.desc,
        typeIdx: tR.get(imp.desc.typeIdx)!,
      };
    }
    if (imp.desc.kind === "tag" && tR.has(imp.desc.typeIdx)) {
      imp.desc = {
        ...imp.desc,
        typeIdx: tR.get(imp.desc.typeIdx)!,
      };
    }
    if (imp.desc.kind === "global" && tR.size > 0) {
      imp.desc = {
        ...imp.desc,
        type: remapVT(imp.desc.type, tR),
      };
    }
  }

  // Remap exports
  for (const ex of mod.exports) {
    if (ex.desc.kind === "func" && fR.has(ex.desc.index)) {
      ex.desc = {
        ...ex.desc,
        index: fR.get(ex.desc.index)!,
      };
    }
  }

  // Remap element segments
  for (const el of mod.elements) {
    el.funcIndices = el.funcIndices.map((f) => fR.get(f) ?? f);
    if (fR.size > 0) remapFuncIdxInBody(el.offset, fR);
    if (tR.size > 0) remapTypeIdxInBody(el.offset, tR);
  }

  // Remap declaredFuncRefs
  mod.declaredFuncRefs = mod.declaredFuncRefs.map((f) => fR.get(f) ?? f);

  // Remap globals
  for (const g of mod.globals) {
    if (tR.size > 0) g.type = remapVT(g.type, tR);
    if (fR.size > 0) remapFuncIdxInBody(g.init, fR);
    if (tR.size > 0) remapTypeIdxInBody(g.init, tR);
  }

  // Remap tags
  for (const tag of mod.tags) {
    if (tR.has(tag.typeIdx)) tag.typeIdx = tR.get(tag.typeIdx)!;
  }
}
