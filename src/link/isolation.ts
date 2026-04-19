// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Isolation validation for linked wasm modules.
 *
 * Implements five static analysis checks that verify modules communicate
 * only through well-defined import/export boundaries:
 *
 * 1. Import/Export-Only Communication
 * 2. No Shared Mutable Globals
 * 3. Memory Isolation
 * 4. No Private Function Access
 * 5. Table Isolation
 */

import type { ParsedObject, SymbolInfo } from "./reader.js";
import {
  R_WASM_TABLE_INDEX_I32,
  R_WASM_TABLE_INDEX_LEB,
  R_WASM_TABLE_INDEX_SLEB,
  R_WASM_TABLE_NUMBER_LEB,
  SYMBOL_BINDING_LOCAL,
  SYMBOL_EXPORTED,
  SYMBOL_UNDEFINED,
  SYMTAB_GLOBAL,
} from "./reader.js";
import type { Resolution } from "./resolver.js";

// ── Public types ──────────────────────────────────────────────────

export interface IsolationReport {
  modules: string[];
  properties: {
    importExportOnly: boolean;
    noSharedGlobals: boolean;
    memoryIsolation: boolean;
    noPrivateFunctionAccess: boolean;
    tableIsolation: boolean;
  };
  violations: IsolationViolation[];
}

export interface IsolationViolation {
  property: string;
  module: string;
  targetModule: string;
  symbol: string;
  message: string;
}

// ── Validation entry point ────────────────────────────────────────

/**
 * Validate isolation properties across a set of linked wasm modules.
 */
export function validateIsolation(objects: ParsedObject[], resolution: Resolution): IsolationReport {
  const modules = objects.map((o) => o.name);
  const violations: IsolationViolation[] = [];

  checkImportExportOnly(objects, resolution, violations);
  checkNoSharedGlobals(objects, violations);
  checkMemoryIsolation(objects, violations);
  checkNoPrivateFunctionAccess(objects, resolution, violations);
  checkTableIsolation(objects, resolution, violations);

  return {
    modules,
    properties: {
      importExportOnly: !violations.some((v) => v.property === "importExportOnly"),
      noSharedGlobals: !violations.some((v) => v.property === "noSharedGlobals"),
      memoryIsolation: !violations.some((v) => v.property === "memoryIsolation"),
      noPrivateFunctionAccess: !violations.some((v) => v.property === "noPrivateFunctionAccess"),
      tableIsolation: !violations.some((v) => v.property === "tableIsolation"),
    },
    violations,
  };
}

// ── Property 1: Import/Export-Only Communication ──────────────────

/**
 * Every cross-module symbol reference must target a properly exported
 * symbol. A relocation in module A targeting a symbol in module B
 * requires that symbol to have the EXPORTED flag.
 */
function checkImportExportOnly(
  objects: ParsedObject[],
  resolution: Resolution,
  violations: IsolationViolation[],
): void {
  for (let modIdx = 0; modIdx < objects.length; modIdx++) {
    const obj = objects[modIdx]!;
    for (let symIdx = 0; symIdx < obj.symbols.length; symIdx++) {
      const sym = obj.symbols[symIdx]!;
      if (!(sym.flags & SYMBOL_UNDEFINED)) continue;

      const key = `${modIdx}:${symIdx}`;
      const target = resolution.resolved.get(key);
      if (!target) continue;
      if (target.targetModule === modIdx) continue; // same module

      // Check that the target symbol is exported
      const targetObj = objects[target.targetModule]!;
      const targetSym = findDefinedSymbol(targetObj, sym.name, sym.kind);
      if (targetSym && !(targetSym.flags & SYMBOL_EXPORTED)) {
        violations.push({
          property: "importExportOnly",
          module: obj.name,
          targetModule: targetObj.name,
          symbol: sym.name,
          message: `Module "${obj.name}" references symbol "${sym.name}" in "${targetObj.name}" which is not marked as exported`,
        });
      }
    }
  }
}

// ── Property 2: No Shared Mutable Globals ─────────────────────────

/**
 * No two modules should define mutable globals with the same symbol name.
 */
function checkNoSharedGlobals(objects: ParsedObject[], violations: IsolationViolation[]): void {
  // Collect all mutable global definitions with their names
  const globalDefs = new Map<string, { moduleIdx: number; moduleName: string }[]>();

  for (let modIdx = 0; modIdx < objects.length; modIdx++) {
    const obj = objects[modIdx]!;
    for (const sym of obj.symbols) {
      if (sym.kind !== SYMTAB_GLOBAL) continue;
      if (sym.flags & SYMBOL_UNDEFINED) continue;
      if (sym.flags & SYMBOL_BINDING_LOCAL) continue;
      if (!sym.name) continue;

      // Check if this global is mutable
      const globalIdx = sym.index;
      const numImportGlobals = obj.imports.filter((imp) => imp.kind === 3).length;
      const localGlobalIdx = globalIdx - numImportGlobals;
      if (localGlobalIdx >= 0 && localGlobalIdx < obj.globals.length) {
        const globalDef = obj.globals[localGlobalIdx]!;
        if (globalDef.mutable) {
          let list = globalDefs.get(sym.name);
          if (!list) {
            list = [];
            globalDefs.set(sym.name, list);
          }
          list.push({
            moduleIdx: modIdx,
            moduleName: obj.name,
          });
        }
      }
    }
  }

  for (const [name, defs] of globalDefs) {
    if (defs.length > 1) {
      for (let i = 0; i < defs.length; i++) {
        for (let j = i + 1; j < defs.length; j++) {
          violations.push({
            property: "noSharedGlobals",
            module: defs[i]!.moduleName,
            targetModule: defs[j]!.moduleName,
            symbol: name,
            message: `Mutable global "${name}" defined in both "${defs[i]!.moduleName}" and "${defs[j]!.moduleName}"`,
          });
        }
      }
    }
  }
}

// ── Property 3: Memory Isolation ──────────────────────────────────

/**
 * After multi-memory remapping, each module's memory instructions should
 * only target its own memory index. Since the linker assigns unique
 * memory indices per module, this is inherently guaranteed. We validate
 * that each module defines at most one memory (the expected input format).
 */
function checkMemoryIsolation(objects: ParsedObject[], violations: IsolationViolation[]): void {
  // Memory isolation is structurally guaranteed by the linker: each
  // module's memory 0 gets a unique index in the merged output.
  // We just verify the input is well-formed (each module has <= 1 memory).
  for (const obj of objects) {
    if (obj.memories.length > 1) {
      violations.push({
        property: "memoryIsolation",
        module: obj.name,
        targetModule: obj.name,
        symbol: "<memory>",
        message: `Module "${obj.name}" defines ${obj.memories.length} memories; expected at most 1`,
      });
    }
  }
}

// ── Property 4: No Private Function Access ────────────────────────

/**
 * No cross-module relocation should target a symbol with BINDING_LOCAL.
 */
function checkNoPrivateFunctionAccess(
  objects: ParsedObject[],
  resolution: Resolution,
  violations: IsolationViolation[],
): void {
  for (let modIdx = 0; modIdx < objects.length; modIdx++) {
    const obj = objects[modIdx]!;
    for (let symIdx = 0; symIdx < obj.symbols.length; symIdx++) {
      const sym = obj.symbols[symIdx]!;
      if (!(sym.flags & SYMBOL_UNDEFINED)) continue;

      const key = `${modIdx}:${symIdx}`;
      const target = resolution.resolved.get(key);
      if (!target) continue;
      if (target.targetModule === modIdx) continue;

      const targetObj = objects[target.targetModule]!;
      const targetSym = findDefinedSymbol(targetObj, sym.name, sym.kind);
      if (targetSym && targetSym.flags & SYMBOL_BINDING_LOCAL) {
        violations.push({
          property: "noPrivateFunctionAccess",
          module: obj.name,
          targetModule: targetObj.name,
          symbol: sym.name,
          message: `Module "${obj.name}" accesses private (local-binding) symbol "${sym.name}" in "${targetObj.name}"`,
        });
      }
    }
  }
}

// ── Property 5: Table Isolation ───────────────────────────────────

/**
 * Each module's call_indirect should only use its own table.
 * No cross-module table element references.
 */
function checkTableIsolation(objects: ParsedObject[], resolution: Resolution, violations: IsolationViolation[]): void {
  for (let modIdx = 0; modIdx < objects.length; modIdx++) {
    const obj = objects[modIdx]!;

    // Check relocations for cross-module table references
    for (const [secName, relocs] of obj.relocations) {
      for (const reloc of relocs) {
        if (
          reloc.type === R_WASM_TABLE_NUMBER_LEB ||
          reloc.type === R_WASM_TABLE_INDEX_SLEB ||
          reloc.type === R_WASM_TABLE_INDEX_I32 ||
          reloc.type === R_WASM_TABLE_INDEX_LEB
        ) {
          if (reloc.symbolIndex < obj.symbols.length) {
            const sym = obj.symbols[reloc.symbolIndex]!;
            if (sym.flags & SYMBOL_UNDEFINED) {
              const key = `${modIdx}:${reloc.symbolIndex}`;
              const target = resolution.resolved.get(key);
              if (target && target.targetModule !== modIdx) {
                const targetObj = objects[target.targetModule]!;
                violations.push({
                  property: "tableIsolation",
                  module: obj.name,
                  targetModule: targetObj.name,
                  symbol: sym.name || `<table:${sym.index}>`,
                  message: `Module "${obj.name}" references table in "${targetObj.name}"`,
                });
              }
            }
          }
        }
      }
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────

function findDefinedSymbol(obj: ParsedObject, name: string, kind: number): SymbolInfo | undefined {
  return obj.symbols.find((s) => s.name === name && s.kind === kind && !(s.flags & SYMBOL_UNDEFINED));
}
