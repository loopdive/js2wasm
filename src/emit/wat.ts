import type {
  WasmModule,
  TypeDef,
  FuncTypeDef,
  ValType,
  Instr,
  BlockType,
  WasmFunction,
  FieldDef,
} from "../ir/types.js";

/**
 * Compute the set of type indices that can be inlined into their sole
 * referencing function definition.  A func type qualifies when:
 *   1. It is a plain "func" type (not struct/array/rec/sub).
 *   2. It is referenced exactly once across the entire module.
 *   3. That single reference comes from a WasmFunction.typeIdx (not from
 *      an import, tag, call_indirect, call_ref, block type, or ValType ref).
 */
function computeInlineableTypes(mod: WasmModule): Set<number> {
  // refCount: total number of references to each type index
  const refCount = new Map<number, number>();
  // nonFuncRef: type indices referenced from non-func-definition contexts
  const nonFuncRef = new Set<number>();

  const bump = (idx: number) => refCount.set(idx, (refCount.get(idx) ?? 0) + 1);
  const markNonFunc = (idx: number) => { bump(idx); nonFuncRef.add(idx); };

  // --- Imports ---
  for (const imp of mod.imports) {
    if (imp.desc.kind === "func") markNonFunc(imp.desc.typeIdx);
  }

  // --- Tags ---
  for (const tag of mod.tags) {
    markNonFunc(tag.typeIdx);
  }

  // --- Functions (the one "func definition" reference) ---
  for (const f of mod.functions) {
    bump(f.typeIdx);
    // Scan instructions for call_indirect, call_ref, and block-type refs
    walkInstrs(f.body, (instr) => {
      if (instr.op === "call_indirect") markNonFunc(instr.typeIdx);
      if (instr.op === "call_ref") markNonFunc(instr.typeIdx);
    });
    walkBlockTypes(f.body, (bt) => {
      if (bt.kind === "type") markNonFunc(bt.typeIdx);
    });
  }

  // Build result set
  const inlineable = new Set<number>();
  for (let i = 0; i < mod.types.length; i++) {
    const t = mod.types[i]!;
    if (
      t.kind === "func" &&
      (refCount.get(i) ?? 0) === 1 &&
      !nonFuncRef.has(i)
    ) {
      inlineable.add(i);
    }
  }
  return inlineable;
}

/** Walk all instructions (recursively into blocks) and call visitor on each */
function walkInstrs(instrs: Instr[], visitor: (instr: Instr) => void): void {
  for (const instr of instrs) {
    visitor(instr);
    if ("body" in instr && Array.isArray((instr as any).body)) {
      walkInstrs((instr as any).body, visitor);
    }
    if ("then" in instr && Array.isArray((instr as any).then)) {
      walkInstrs((instr as any).then, visitor);
    }
    if ("else" in instr && Array.isArray((instr as any).else)) {
      walkInstrs((instr as any).else, visitor);
    }
    if ("catches" in instr && Array.isArray((instr as any).catches)) {
      for (const c of (instr as any).catches) {
        if (Array.isArray(c.body)) walkInstrs(c.body, visitor);
      }
    }
    if ("catchAll" in instr && Array.isArray((instr as any).catchAll)) {
      walkInstrs((instr as any).catchAll, visitor);
    }
  }
}

/** Walk all block types in instructions */
function walkBlockTypes(instrs: Instr[], visitor: (bt: BlockType) => void): void {
  for (const instr of instrs) {
    if ("blockType" in instr) {
      visitor((instr as any).blockType);
    }
    if ("body" in instr && Array.isArray((instr as any).body)) {
      walkBlockTypes((instr as any).body, visitor);
    }
    if ("then" in instr && Array.isArray((instr as any).then)) {
      walkBlockTypes((instr as any).then, visitor);
    }
    if ("else" in instr && Array.isArray((instr as any).else)) {
      walkBlockTypes((instr as any).else, visitor);
    }
    if ("catches" in instr && Array.isArray((instr as any).catches)) {
      for (const c of (instr as any).catches) {
        if (Array.isArray(c.body)) walkBlockTypes(c.body, visitor);
      }
    }
    if ("catchAll" in instr && Array.isArray((instr as any).catchAll)) {
      walkBlockTypes((instr as any).catchAll, visitor);
    }
  }
}

/** Emit a WAT text representation of the IR module */
export function emitWat(mod: WasmModule): string {
  const lines: string[] = [];
  const indent = (depth: number) => "  ".repeat(depth);
  const inlineableTypes = computeInlineableTypes(mod);

  lines.push("(module");

  // Types — skip single-use func types that will be inlined on their function
  for (let i = 0; i < mod.types.length; i++) {
    if (inlineableTypes.has(i)) continue;
    const t = mod.types[i]!;
    lines.push(`${indent(1)}${formatTypeDef(t, i)}`);
  }

  // Imports
  for (const imp of mod.imports) {
    const desc =
      imp.desc.kind === "func"
        ? `(func $${imp.name}_import (type ${imp.desc.typeIdx}))`
        : imp.desc.kind === "global"
          ? `(global $${imp.name} ${imp.desc.mutable ? `(mut ${formatValType(imp.desc.type)})` : formatValType(imp.desc.type)})`
          : `(table ${imp.desc.min} ${imp.desc.max ?? ""} ${imp.desc.elementType})`;
    lines.push(
      `${indent(1)}(import "${imp.module}" "${imp.name}" ${desc})`,
    );
  }

  // Globals
  for (const g of mod.globals) {
    const mutStr = g.mutable
      ? `(mut ${formatValType(g.type)})`
      : formatValType(g.type);
    const initStr = g.init.map((i) => formatInstr(i, 0)).join(" ");
    lines.push(
      `${indent(1)}(global $${g.name} ${mutStr} (${initStr}))`,
    );
  }

  // Tables
  for (const t of mod.tables) {
    lines.push(
      `${indent(1)}(table ${t.min} ${t.max !== undefined ? t.max : ""} ${t.elementType})`,
    );
  }

  // Memories
  if (mod.memories) {
    for (const mem of mod.memories) {
      if (mem.max !== undefined) {
        lines.push(`${indent(1)}(memory ${mem.min} ${mem.max})`);
      } else {
        lines.push(`${indent(1)}(memory ${mem.min})`);
      }
    }
  }

  // Elements
  for (const elem of mod.elements) {
    const offsetStr = elem.offset.map((i) => formatInstr(i, 0)).join(" ");
    const funcStr = elem.funcIndices.join(" ");
    lines.push(
      `${indent(1)}(elem (offset ${offsetStr}) func ${funcStr})`,
    );
  }

  // Declarative element segment for ref.func targets
  if (mod.declaredFuncRefs.length > 0) {
    const funcStr = mod.declaredFuncRefs.join(" ");
    lines.push(
      `${indent(1)}(elem declare func ${funcStr})`,
    );
  }

  // Tags
  for (let i = 0; i < mod.tags.length; i++) {
    const tag = mod.tags[i]!;
    lines.push(`${indent(1)}(tag $${tag.name} (type ${tag.typeIdx}))`);
  }

  // Functions
  const numImportFuncs = mod.imports.filter(
    (i) => i.desc.kind === "func",
  ).length;

  for (let i = 0; i < mod.functions.length; i++) {
    const f = mod.functions[i]!;
    lines.push(formatFunction(f, i + numImportFuncs, mod, inlineableTypes));
  }

  // Exports
  for (const exp of mod.exports) {
    lines.push(
      `${indent(1)}(export "${exp.name}" (${exp.desc.kind} ${exp.desc.index}))`,
    );
  }

  // Data segments (active, for linear memory)
  if (mod.dataSegments && mod.dataSegments.length > 0) {
    for (const seg of mod.dataSegments) {
      const hexBytes = Array.from(seg.bytes)
        .map((b) => `\\${b.toString(16).padStart(2, "0")}`)
        .join("");
      lines.push(
        `${indent(1)}(data (i32.const ${seg.offset}) "${hexBytes}")`,
      );
    }
  }

  lines.push(")");
  return lines.join("\n");
}

function formatTypeDef(t: TypeDef, idx: number): string {
  switch (t.kind) {
    case "func": {
      const params = t.params.map((p) => formatValType(p)).join(" ");
      const results = t.results.map((r) => formatValType(r)).join(" ");
      return `(type $${t.name || `type${idx}`} (func${params ? ` (param ${params})` : ""}${results ? ` (result ${results})` : ""}))`;
    }
    case "struct": {
      const fields = t.fields
        .map((f) => formatFieldDef(f))
        .join(" ");
      if (t.superTypeIdx !== undefined) {
        const superStr = t.superTypeIdx >= 0 ? ` $type${t.superTypeIdx}` : "";
        return `(type $${t.name} (sub${superStr} (struct ${fields})))`;
      }
      return `(type $${t.name} (struct ${fields}))`;
    }
    case "array":
      return `(type $${t.name} (array ${t.mutable ? "(mut " : ""}${formatStorageType(t.element)}${t.mutable ? ")" : ""}))`;
    case "rec": {
      const inner = t.types
        .map((sub, i) => `    ${formatTypeDef(sub, idx + i)}`)
        .join("\n");
      return `(rec\n${inner}\n  )`;
    }
    case "sub": {
      const superStr =
        t.superType !== null ? ` $type${t.superType}` : "";
      const innerType = formatTypeDef(t.type, idx);
      return `(type $${t.name} (sub${superStr} ${innerType.replace(/^\(type \$\S+ /, "").replace(/\)$/, "")}))`;
    }
  }
}

function formatStorageType(t: ValType): string {
  if (t.kind === "i16") return "i16";
  return formatValType(t);
}

function formatFieldDef(f: FieldDef): string {
  const mutStr = f.mutable ? `(mut ${formatStorageType(f.type)})` : formatStorageType(f.type);
  return `(field $${f.name} ${mutStr})`;
}

function formatValType(t: ValType): string {
  switch (t.kind) {
    case "i32":
      return "i32";
    case "i64":
      return "i64";
    case "f32":
      return "f32";
    case "f64":
      return "f64";
    case "funcref":
      return "funcref";
    case "externref":
      return "externref";
    case "eqref":
      return "eqref";
    case "anyref":
      return "anyref";
    case "ref_extern":
      return "(ref extern)";
    case "ref":
      return `(ref ${t.typeIdx})`;
    case "ref_null":
      return `(ref null ${t.typeIdx})`;
    case "i16":
      return "i16";
  }
}

function formatFunction(
  f: WasmFunction,
  _globalIdx: number,
  mod: WasmModule,
  inlineableTypes: Set<number>,
): string {
  const lines: string[] = [];

  // If the function's type is single-use, inline the signature instead of referencing the type
  let sigStr: string;
  if (inlineableTypes.has(f.typeIdx)) {
    const t = mod.types[f.typeIdx] as FuncTypeDef;
    const params = t.params.map((p) => formatValType(p)).join(" ");
    const results = t.results.map((r) => formatValType(r)).join(" ");
    sigStr = `${params ? ` (param ${params})` : ""}${results ? ` (result ${results})` : ""}`;
  } else {
    sigStr = ` (type ${f.typeIdx})`;
  }

  // Exports are emitted via mod.exports (trailing export section) — no inline export here
  lines.push(`  (func $${f.name}${sigStr}`);

  // Locals
  for (const local of f.locals) {
    lines.push(`    (local $${local.name} ${formatValType(local.type)})`);
  }

  // Body
  for (const instr of f.body) {
    lines.push(formatInstrIndented(instr, 2));
  }

  lines.push("  )");
  return lines.join("\n");
}

function formatInstrIndented(instr: Instr, depth: number): string {
  const pad = "  ".repeat(depth);

  switch (instr.op) {
    case "block": {
      const bt = formatBlockType(instr.blockType);
      const inner = instr.body
        .map((i) => formatInstrIndented(i, depth + 1))
        .join("\n");
      return `${pad}(block${bt}\n${inner}\n${pad})`;
    }
    case "loop": {
      const bt = formatBlockType(instr.blockType);
      const inner = instr.body
        .map((i) => formatInstrIndented(i, depth + 1))
        .join("\n");
      return `${pad}(loop${bt}\n${inner}\n${pad})`;
    }
    case "if": {
      const bt = formatBlockType(instr.blockType);
      const thenStr = instr.then
        .map((i) => formatInstrIndented(i, depth + 1))
        .join("\n");
      const hasElse = instr.else && instr.else.length > 0;
      const needsElse = hasElse || instr.blockType.kind === "val";
      if (needsElse) {
        const elseStr = hasElse
          ? instr.else!.map((i) => formatInstrIndented(i, depth + 1)).join("\n")
          : `${pad}    unreachable`;
        return `${pad}(if${bt}\n${pad}  (then\n${thenStr}\n${pad}  )\n${pad}  (else\n${elseStr}\n${pad}  )\n${pad})`;
      }
      return `${pad}(if${bt}\n${pad}  (then\n${thenStr}\n${pad}  )\n${pad})`;
    }
    case "try": {
      const bt = formatBlockType(instr.blockType);
      let result = `${pad}(try${bt}\n${pad}  (do\n`;
      result += instr.body.map((i) => formatInstrIndented(i, depth + 2)).join("\n");
      result += `\n${pad}  )`;
      for (const c of instr.catches) {
        result += `\n${pad}  (catch ${c.tagIdx}\n`;
        result += c.body.map((i) => formatInstrIndented(i, depth + 2)).join("\n");
        result += `\n${pad}  )`;
      }
      if (instr.catchAll) {
        result += `\n${pad}  (catch_all\n`;
        result += instr.catchAll.map((i) => formatInstrIndented(i, depth + 2)).join("\n");
        result += `\n${pad}  )`;
      }
      result += `\n${pad})`;
      return result;
    }
    default:
      return `${pad}${formatInstr(instr, depth)}`;
  }
}

function formatBlockType(bt: BlockType): string {
  switch (bt.kind) {
    case "empty":
      return "";
    case "val":
      return ` (result ${formatValType(bt.type)})`;
    case "type":
      return ` (type ${bt.typeIdx})`;
  }
}

function formatInstr(instr: Instr, _depth: number): string {
  switch (instr.op) {
    case "local.get":
      return `local.get ${instr.index}`;
    case "local.set":
      return `local.set ${instr.index}`;
    case "local.tee":
      return `local.tee ${instr.index}`;
    case "global.get":
      return `global.get ${instr.index}`;
    case "global.set":
      return `global.set ${instr.index}`;
    case "i32.const":
      return `i32.const ${instr.value}`;
    case "i64.const":
      return `i64.const ${instr.value}`;
    case "f64.const":
      return `f64.const ${instr.value}`;
    case "f32.const":
      return `f32.const ${instr.value}`;
    case "br":
      return `br ${instr.depth}`;
    case "br_if":
      return `br_if ${instr.depth}`;
    case "call":
      return `call ${instr.funcIdx}`;
    case "call_indirect":
      return `call_indirect (type ${instr.typeIdx})`;
    case "struct.new":
      return `struct.new ${instr.typeIdx}`;
    case "struct.get":
      return `struct.get ${instr.typeIdx} ${instr.fieldIdx}`;
    case "struct.set":
      return `struct.set ${instr.typeIdx} ${instr.fieldIdx}`;
    case "array.new":
      return `array.new ${instr.typeIdx}`;
    case "array.new_fixed":
      return `array.new_fixed ${instr.typeIdx} ${instr.length}`;
    case "array.new_default":
      return `array.new_default ${instr.typeIdx}`;
    case "array.get":
      return `array.get ${instr.typeIdx}`;
    case "array.get_s":
      return `array.get_s ${instr.typeIdx}`;
    case "array.get_u":
      return `array.get_u ${instr.typeIdx}`;
    case "array.set":
      return `array.set ${instr.typeIdx}`;
    case "array.copy":
      return `array.copy ${instr.dstTypeIdx} ${instr.srcTypeIdx}`;
    case "array.fill":
      return `array.fill ${instr.typeIdx}`;
    case "ref.null":
      return `ref.null ${instr.typeIdx}`;
    case "ref.null.extern":
      return "ref.null extern";
    case "ref.null.eq":
      return "ref.null eq";
    case "ref.cast":
      return `ref.cast (ref ${instr.typeIdx})`;
    case "any.convert_extern":
      return "any.convert_extern";
    case "extern.convert_any":
      return "extern.convert_any";
    case "ref.test":
      return `ref.test (ref ${instr.typeIdx})`;
    case "ref.func":
      return `ref.func ${instr.funcIdx}`;
    case "call_ref":
      return `call_ref ${instr.typeIdx}`;
    case "throw":
      return `throw ${instr.tagIdx}`;
    case "rethrow":
      return `rethrow ${instr.depth}`;
    // Memory load/store (linear memory)
    case "i32.load":
    case "i32.load8_u":
    case "i32.load8_s":
    case "i32.load16_u":
    case "i32.store":
    case "i32.store8":
    case "i32.store16":
      return `${instr.op} offset=${instr.offset} align=${1 << instr.align}`;
    default:
      return instr.op;
  }
}
