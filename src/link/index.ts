/**
 * Public API for the multi-memory module linker.
 */

export { link } from "./linker.js";
export type { LinkOptions, LinkResult, LinkError } from "./linker.js";
export type {
  IsolationReport,
  IsolationViolation,
} from "./isolation.js";
export { validateIsolation } from "./isolation.js";
export { parseObject } from "./reader.js";
export type {
  ParsedObject,
  SymbolInfo,
  RelocEntry,
  MemoryEntry,
  TypeSection,
  ImportEntry,
  FunctionEntry,
  TableEntry,
  GlobalEntry,
  ExportEntry,
  ElementEntry,
  TagEntry,
  CodeEntry,
} from "./reader.js";
export { resolveSymbols } from "./resolver.js";
export type { Resolution, ResolvedSymbol } from "./resolver.js";
