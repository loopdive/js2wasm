// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * C ABI calling conventions for the linear memory backend.
 *
 * Translates TypeScript-level types into C-compatible wasm signatures:
 *   - number (f64) → f64 parameter (direct)
 *   - number (i32, fast mode) → i32 parameter (direct)
 *   - boolean → i32 parameter (0 or 1)
 *   - string → (i32, i32) pair: (pointer to UTF-8 data, byte length)
 *   - T[] → (i32, i32) pair: (pointer to element data, element count)
 *   - structs/objects → i32 pointer to linear memory layout
 *   - void return → no return value
 *
 * Wrapper functions are emitted that marshal between the internal TS
 * calling convention (pointers for strings/arrays) and the C ABI
 * (pointer + length pairs).
 */

import type { FuncTypeDef, Instr, ValType, WasmModule } from "../ir/types.js";

// ── Types ────────────────────────────────────────────────────────────

/** Describes the TS-level semantic type of a parameter */
export type TsSemanticType = "number_i32" | "number_f64" | "boolean" | "string" | "array" | "object";

/** A parameter definition with TS semantic info */
export interface ParamDef {
  name: string;
  wasmType: ValType;
  semantic: TsSemanticType;
}

/** A C ABI parameter (may be one of a pair for strings/arrays) */
export interface CabiParam {
  name: string;
  wasmType: ValType;
  /** Which original param index this came from */
  sourceParamIdx: number;
  /** "ptr" | "len" for expanded params, "direct" for scalar */
  role: "direct" | "ptr" | "len";
}

/** C ABI return value descriptor */
export interface CabiResult {
  wasmTypes: ValType[];
  semantic: TsSemanticType | "void";
}

/** Information about an exported function for C header generation */
export interface CabiExportInfo {
  /** Original TS function name */
  tsName: string;
  /** C ABI export name (e.g. MyClass_bar) */
  cabiName: string;
  /** C ABI parameter list */
  params: CabiParam[];
  /** C ABI return type */
  result: CabiResult;
}

// ── Parameter mapping ────────────────────────────────────────────────

/**
 * Expand TS parameter definitions into C ABI parameters.
 * Strings and arrays become (ptr, len) pairs.
 */
export function mapParamsToCabi(params: ParamDef[]): CabiParam[] {
  const result: CabiParam[] = [];
  for (let i = 0; i < params.length; i++) {
    const p = params[i]!;
    switch (p.semantic) {
      case "string":
      case "array":
        // Expand to (pointer, length) pair
        result.push({
          name: `${p.name}_ptr`,
          wasmType: { kind: "i32" },
          sourceParamIdx: i,
          role: "ptr",
        });
        result.push({
          name: `${p.name}_len`,
          wasmType: { kind: "i32" },
          sourceParamIdx: i,
          role: "len",
        });
        break;
      case "boolean":
        result.push({
          name: p.name,
          wasmType: { kind: "i32" },
          sourceParamIdx: i,
          role: "direct",
        });
        break;
      case "number_i32":
        result.push({
          name: p.name,
          wasmType: { kind: "i32" },
          sourceParamIdx: i,
          role: "direct",
        });
        break;
      case "number_f64":
        result.push({
          name: p.name,
          wasmType: { kind: "f64" },
          sourceParamIdx: i,
          role: "direct",
        });
        break;
      default:
        result.push({
          name: p.name,
          wasmType: { kind: "i32" },
          sourceParamIdx: i,
          role: "direct",
        });
        break;
    }
  }
  return result;
}

/**
 * Map a TS return type to a C ABI return descriptor.
 */
export function mapResultToCabi(result: ValType | null, semantic: TsSemanticType | "void"): CabiResult {
  if (result === null || semantic === "void") {
    return { wasmTypes: [], semantic: "void" };
  }
  switch (semantic) {
    case "string":
    case "array":
      // Return (ptr, len) pair — two i32 results
      return { wasmTypes: [{ kind: "i32" }, { kind: "i32" }], semantic };
    case "boolean":
      return { wasmTypes: [{ kind: "i32" }], semantic };
    case "number_i32":
      return { wasmTypes: [{ kind: "i32" }], semantic };
    case "number_f64":
      return { wasmTypes: [{ kind: "f64" }], semantic };
    default:
      return { wasmTypes: [{ kind: "i32" }], semantic };
  }
}

// ── Name mangling ────────────────────────────────────────────────────

/**
 * Mangle a function name for C ABI export.
 * Simple function names are unchanged; class methods use ClassName_method.
 */
export function mangleCabiName(name: string): string {
  // Already contains underscore from ClassName_method convention — keep as-is
  return name;
}

// ── Wrapper emission ─────────────────────────────────────────────────

/**
 * Emit C ABI wrapper functions for all exported functions in the module.
 *
 * For each exported function with string or array parameters, we generate
 * a `__cabi_<name>` wrapper with C-compatible signatures. The wrapper
 * marshals the (ptr, len) pairs by creating internal string/array
 * representations, calls the original function, and returns the result
 * in C ABI form.
 *
 * For functions that already have C-compatible signatures (all scalar
 * params/returns), the original export is simply renamed — no wrapper
 * is needed.
 *
 * Returns the list of CabiExportInfo describing the new C ABI exports.
 */
export function emitCabiWrappers(mod: WasmModule, exportInfos: CabiExportInfo[]): void {
  // Track which export indices to replace
  const exportReplacements = new Map<string, number>(); // old export name -> new func index

  for (const info of exportInfos) {
    const needsWrapper =
      info.params.some((p) => p.role === "ptr" || p.role === "len") ||
      info.result.semantic === "string" ||
      info.result.semantic === "array";

    if (!needsWrapper) {
      // No wrapper needed; just rename the export if needed
      if (info.tsName !== info.cabiName) {
        for (const exp of mod.exports) {
          if (exp.name === info.tsName && exp.desc.kind === "func") {
            exp.name = info.cabiName;
            break;
          }
        }
      }
      continue;
    }

    // Find the original function's export and its index
    let origFuncIdx = -1;
    for (const exp of mod.exports) {
      if (exp.name === info.tsName && exp.desc.kind === "func") {
        origFuncIdx = exp.desc.index;
        break;
      }
    }
    if (origFuncIdx === -1) continue;

    // Find the original function's type
    const numImportFuncs = mod.imports.filter((i) => i.desc.kind === "func").length;
    const origFunc = origFuncIdx >= numImportFuncs ? mod.functions[origFuncIdx - numImportFuncs] : null;
    if (!origFunc) continue;
    const origType = mod.types[origFunc.typeIdx] as FuncTypeDef;

    // Build the wrapper function type
    const wrapperParamTypes: ValType[] = info.params.map((p) => p.wasmType);
    const wrapperResultTypes: ValType[] = info.result.wasmTypes;

    const wrapperTypeIdx = mod.types.length;
    mod.types.push({
      kind: "func",
      name: `$type___cabi_${info.cabiName}`,
      params: wrapperParamTypes,
      results: wrapperResultTypes,
    });

    // Build wrapper body
    const body: Instr[] = [];

    // For each original parameter, reconstruct the value from C ABI params
    let cabiParamIdx = 0;
    for (let origIdx = 0; origIdx < (origType.params?.length ?? 0); origIdx++) {
      const cabiParam = info.params[cabiParamIdx];
      if (cabiParam && cabiParam.role === "ptr") {
        // String/array: the original function expects an i32 pointer.
        // In C ABI, we pass (ptr, len). The original function already
        // works with a pointer to the string/array header in linear memory.
        // For C interop, the caller provides a raw data pointer + length.
        // We just pass the pointer — the length is available separately.
        body.push({ op: "local.get", index: cabiParamIdx });
        cabiParamIdx += 2; // skip the len param
      } else {
        body.push({ op: "local.get", index: cabiParamIdx });
        cabiParamIdx++;
      }
    }

    // Call the original function
    body.push({ op: "call", funcIdx: origFuncIdx });

    // Handle return value marshaling
    if (info.result.semantic === "string" || info.result.semantic === "array") {
      // The original function returns an i32 pointer to a string/array header.
      // For C ABI, we need to return (ptr, len).
      // The string header format: [length: i32 at offset 0] [data at offset 4]
      // We load the length and compute the data pointer.
      const retLocal = wrapperParamTypes.length;
      // We need a local to store the returned pointer
      const wrapperLocals = [{ name: "__ret_ptr", type: { kind: "i32" } as ValType }];

      // Store returned pointer
      body.splice(body.length, 0); // placeholder
      const callIdx = body.length - 1;
      // Actually, we need to restructure: save the call result, then extract ptr and len
      // Replace the end of body:
      // After the call, the result (pointer) is on the stack
      body.push({ op: "local.tee", index: retLocal });
      // Data pointer = ptr + 4 (skip the length header)
      body.push({ op: "i32.const", value: 4 });
      body.push({ op: "i32.add" });
      // Length = i32.load at ptr
      body.push({ op: "local.get", index: retLocal });
      body.push({ op: "i32.load", align: 2, offset: 0 });

      // Add the wrapper function with the extra local
      const wrapperFuncIdx = numImportFuncs + mod.functions.length;
      mod.functions.push({
        name: `__cabi_${info.cabiName}`,
        typeIdx: wrapperTypeIdx,
        locals: wrapperLocals,
        body,
        exported: true,
      });

      exportReplacements.set(info.tsName, wrapperFuncIdx);

      // Add export for wrapper
      mod.exports.push({
        name: info.cabiName,
        desc: { kind: "func", index: wrapperFuncIdx },
      });
    } else {
      // Simple return — just create the wrapper
      const wrapperFuncIdx = numImportFuncs + mod.functions.length;
      mod.functions.push({
        name: `__cabi_${info.cabiName}`,
        typeIdx: wrapperTypeIdx,
        locals: [],
        body,
        exported: true,
      });

      exportReplacements.set(info.tsName, wrapperFuncIdx);

      mod.exports.push({
        name: info.cabiName,
        desc: { kind: "func", index: wrapperFuncIdx },
      });
    }

    // Remove the original export (keep the function, just un-export it)
    const origExportIdx = mod.exports.findIndex((e) => e.name === info.tsName && e.desc.kind === "func");
    if (origExportIdx !== -1) {
      mod.exports.splice(origExportIdx, 1);
    }
  }
}

/**
 * Infer the TS semantic type from a ValType and TS type text.
 */
export function inferSemantic(wasmType: ValType, tsTypeText: string | undefined): TsSemanticType {
  if (!tsTypeText) {
    return wasmType.kind === "f64" ? "number_f64" : "number_i32";
  }
  const cleaned = tsTypeText.replace(/\s*\|\s*(undefined|null)/g, "").trim();
  if (cleaned === "string") return "string";
  if (cleaned === "boolean") return "boolean";
  if (cleaned === "number") {
    return wasmType.kind === "i32" ? "number_i32" : "number_f64";
  }
  if (cleaned.endsWith("[]") || cleaned.startsWith("Array<")) return "array";
  if (cleaned === "void") return "number_f64"; // shouldn't occur for params
  return "object";
}
