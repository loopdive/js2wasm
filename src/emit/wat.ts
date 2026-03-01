import type {
  WasmModule,
  TypeDef,
  ValType,
  Instr,
  BlockType,
  WasmFunction,
  FieldDef,
} from "../ir/types.js";

/** Emit a WAT text representation of the IR module */
export function emitWat(mod: WasmModule): string {
  const lines: string[] = [];
  const indent = (depth: number) => "  ".repeat(depth);

  lines.push("(module");

  // Types
  for (let i = 0; i < mod.types.length; i++) {
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

  // Elements
  for (const elem of mod.elements) {
    const offsetStr = elem.offset.map((i) => formatInstr(i, 0)).join(" ");
    const funcStr = elem.funcIndices.join(" ");
    lines.push(
      `${indent(1)}(elem (offset ${offsetStr}) func ${funcStr})`,
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
    lines.push(formatFunction(f, i + numImportFuncs, mod));
  }

  // Exports
  for (const exp of mod.exports) {
    lines.push(
      `${indent(1)}(export "${exp.name}" (${exp.desc.kind} ${exp.desc.index}))`,
    );
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
      return `(type $${t.name} (struct ${fields}))`;
    }
    case "array":
      return `(type $${t.name} (array ${t.mutable ? "(mut " : ""}${formatValType(t.element)}${t.mutable ? ")" : ""}))`;
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

function formatFieldDef(f: FieldDef): string {
  const mutStr = f.mutable ? `(mut ${formatValType(f.type)})` : formatValType(f.type);
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
    case "ref":
      return `(ref ${t.typeIdx})`;
    case "ref_null":
      return `(ref null ${t.typeIdx})`;
  }
}

function formatFunction(
  f: WasmFunction,
  _globalIdx: number,
  _mod: WasmModule,
): string {
  const lines: string[] = [];
  const typeRef = `(type ${f.typeIdx})`;

  // Find type for params display
  const exportStr = f.exported ? ` (export "${f.name}")` : "";
  lines.push(`  (func $${f.name}${exportStr} ${typeRef}`);

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
    default:
      return instr.op;
  }
}
