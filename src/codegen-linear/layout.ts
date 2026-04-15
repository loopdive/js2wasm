// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Class layout computation for the linear-memory backend.
 *
 * Each class instance is stored on the heap with the following layout:
 *   [type_tag: u8 at +0][padding 3B][payload_size: u32 at +4][field0: 8B at +8][field1: 8B at +16]...
 *
 * The header is 8 bytes (tag + padding + payload_size).
 * Each field occupies 8 bytes for uniform access (f64 for numbers, i32 stored in
 * the low 4 bytes for object references).
 */

export interface ClassLayout {
  name: string;
  /** Total allocation size: header (8) + 8 bytes per field */
  totalSize: number;
  /** Map from field name to its memory offset and wasm type */
  fields: Map<string, { offset: number; type: "i32" | "f64" }>;
  /** Map from field name to TS collection kind (for nested property access) */
  fieldCollectionKinds: Map<string, "Array" | "Uint8Array" | "Map" | "Set">;
  /** Map from method name to its wasm function name */
  methods: Map<string, string>;
  /** Map from getter property name to its wasm function name */
  getters: Map<string, string>;
  /** Wasm function name for the constructor */
  ctorFuncName: string;
}

/**
 * Compute the memory layout for a class with the given fields.
 *
 * @param name - The class name
 * @param fieldDefs - Array of { name, type } where type is "i32" or "f64"
 * @returns The computed ClassLayout
 */
export function computeClassLayout(name: string, fieldDefs: { name: string; type: "i32" | "f64" }[]): ClassLayout {
  const HEADER_SIZE = 8; // tag (1) + padding (3) + payload_size (4)
  const FIELD_SIZE = 8; // each field gets 8 bytes for uniform access

  const fields = new Map<string, { offset: number; type: "i32" | "f64" }>();
  let offset = HEADER_SIZE;
  for (const f of fieldDefs) {
    fields.set(f.name, { offset, type: f.type });
    offset += FIELD_SIZE;
  }

  return {
    name,
    totalSize: offset,
    fields,
    fieldCollectionKinds: new Map(),
    methods: new Map(),
    getters: new Map(),
    ctorFuncName: `${name}_ctor`,
  };
}
