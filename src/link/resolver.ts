/**
 * Symbol resolution for wasm object files.
 *
 * Given a list of parsed .o files, resolves undefined symbols by finding
 * matching exported definitions in other modules. Reports errors for
 * unresolved or duplicated symbols.
 */

import type { ParsedObject, SymbolInfo } from "./reader.js";
import {
  SYMTAB_FUNCTION,
  SYMTAB_GLOBAL,
  SYMTAB_DATA,
  SYMTAB_EVENT,
  SYMTAB_TABLE,
  SYMBOL_UNDEFINED,
  SYMBOL_EXPORTED,
  SYMBOL_BINDING_LOCAL,
  SYMBOL_BINDING_WEAK,
} from "./reader.js";

// ── Public types ──────────────────────────────────────────────────

export interface Resolution {
  /** Map from "moduleIdx:symbolIdx" → resolved target */
  resolved: Map<string, ResolvedSymbol>;
  errors: string[];
}

export interface ResolvedSymbol {
  targetModule: number;
  targetIndex: number;
  name: string;
}

// ── Symbol resolution ─────────────────────────────────────────────

/**
 * Resolve symbols across a set of parsed wasm object files.
 *
 * For each undefined symbol in a module, search other modules for an
 * exported (or at least non-undefined, non-local) definition with the
 * same name and kind.
 */
export function resolveSymbols(objects: ParsedObject[]): Resolution {
  const resolved = new Map<string, ResolvedSymbol>();
  const errors: string[] = [];

  // Build a map of exported/defined symbols: name → (moduleIdx, symbolIdx, SymbolInfo)
  const definedSymbols = new Map<
    string,
    { moduleIdx: number; symbolIdx: number; symbol: SymbolInfo }[]
  >();

  for (let modIdx = 0; modIdx < objects.length; modIdx++) {
    const obj = objects[modIdx]!;
    for (let symIdx = 0; symIdx < obj.symbols.length; symIdx++) {
      const sym = obj.symbols[symIdx]!;
      // Skip undefined symbols (they are imports that need resolving)
      if (sym.flags & SYMBOL_UNDEFINED) continue;
      // Skip local-binding symbols (not visible to other modules)
      if (sym.flags & SYMBOL_BINDING_LOCAL) continue;
      // Skip unnamed symbols
      if (!sym.name) continue;

      const key = `${sym.kind}:${sym.name}`;
      let list = definedSymbols.get(key);
      if (!list) {
        list = [];
        definedSymbols.set(key, list);
      }
      list.push({ moduleIdx: modIdx, symbolIdx: symIdx, symbol: sym });
    }
  }

  // Check for duplicate strong definitions
  for (const [key, defs] of definedSymbols) {
    const strongDefs = defs.filter(
      (d) => !(d.symbol.flags & SYMBOL_BINDING_WEAK),
    );
    if (strongDefs.length > 1) {
      const [kindStr, ...nameParts] = key.split(":");
      const symbolName = nameParts.join(":");
      const moduleNames = strongDefs.map(
        (d) => objects[d.moduleIdx]!.name,
      );
      errors.push(
        `Duplicate symbol "${symbolName}" (kind ${kindStr}) defined in: ${moduleNames.join(", ")}`,
      );
    }
  }

  // Resolve undefined symbols
  for (let modIdx = 0; modIdx < objects.length; modIdx++) {
    const obj = objects[modIdx]!;
    for (let symIdx = 0; symIdx < obj.symbols.length; symIdx++) {
      const sym = obj.symbols[symIdx]!;

      // Only resolve undefined symbols
      if (!(sym.flags & SYMBOL_UNDEFINED)) continue;
      if (!sym.name) continue;

      const key = `${sym.kind}:${sym.name}`;
      const defs = definedSymbols.get(key);

      if (!defs || defs.length === 0) {
        errors.push(
          `Unresolved symbol "${sym.name}" (kind ${sym.kind}) in module "${obj.name}"`,
        );
        continue;
      }

      // Prefer strong definitions over weak ones
      const strongDefs = defs.filter(
        (d) => !(d.symbol.flags & SYMBOL_BINDING_WEAK),
      );
      const chosen = strongDefs.length > 0 ? strongDefs[0]! : defs[0]!;

      const mapKey = `${modIdx}:${symIdx}`;
      resolved.set(mapKey, {
        targetModule: chosen.moduleIdx,
        targetIndex: chosen.symbol.index,
        name: sym.name,
      });
    }
  }

  return { resolved, errors };
}
