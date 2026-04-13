// Copyright (c) 2026 Loopdive GmbH. Licensed under AGPL-3.0.
/**
 * Public API for the multi-memory module linker.
 */

export { validateIsolation } from "./isolation.js";
export type { IsolationReport, IsolationViolation } from "./isolation.js";
export { link } from "./linker.js";
export type { LinkError, LinkOptions, LinkResult } from "./linker.js";
export { parseObject } from "./reader.js";
export type {
  CodeEntry,
  ElementEntry,
  ExportEntry,
  FunctionEntry,
  GlobalEntry,
  ImportEntry,
  MemoryEntry,
  ParsedObject,
  RelocEntry,
  SymbolInfo,
  TableEntry,
  TagEntry,
  TypeSection,
} from "./reader.js";
export { resolveSymbols } from "./resolver.js";
export type { Resolution, ResolvedSymbol } from "./resolver.js";
