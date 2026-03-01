import { describe, it, expect } from "vitest";
import {
  buildTestObjectWithNamedImports,
  SYMBOL_EXPORTED,
  SYMBOL_UNDEFINED,
  SYMBOL_EXPLICIT_NAME,
  SYMTAB_FUNCTION,
} from "./link-helpers.js";
import { parseObject } from "../src/link/reader.js";
import { resolveSymbols } from "../src/link/resolver.js";
import { link } from "../src/link/linker.js";

// ── Helpers ───────────────────────────────────────────────────────

/** i32 value type byte */
const I32 = 0x7f;
/** f64 value type byte */
const F64 = 0x7c;

/**
 * Create a minimal module that exports a function "add" of type
 * (i32, i32) -> i32 with a body that does i32.add.
 */
function makeExporterModule(name: string): Uint8Array {
  return buildTestObjectWithNamedImports({
    name,
    types: [{ params: [I32, I32], results: [I32] }],
    functions: [
      {
        typeIdx: 0,
        exported: true,
        name: "add",
        // local.get 0, local.get 1, i32.add
        body: [0x20, 0x00, 0x20, 0x01, 0x6a],
      },
    ],
    memories: [{ min: 1 }],
  });
}

/**
 * Create a module that imports "add" and has a function "callAdd"
 * that calls it with constants.
 */
function makeImporterModule(name: string): Uint8Array {
  return buildTestObjectWithNamedImports({
    name,
    types: [
      { params: [I32, I32], results: [I32] }, // type 0: (i32, i32) -> i32
      { params: [], results: [I32] }, // type 1: () -> i32
    ],
    imports: [{ module: "env", name: "add", typeIdx: 0 }],
    functions: [
      {
        typeIdx: 1,
        exported: true,
        name: "callAdd",
        // i32.const 3, i32.const 4, call 0 (imported "add")
        body: [0x41, 0x03, 0x41, 0x04, 0x10, 0x00],
      },
    ],
    memories: [{ min: 1 }],
  });
}

// ── Tests ─────────────────────────────────────────────────────────

describe("linker", () => {
  describe("parseObject", () => {
    it("should parse a valid .o file", () => {
      const bytes = makeExporterModule("test");
      const parsed = parseObject("test", bytes);

      expect(parsed.name).toBe("test");
      expect(parsed.types).toHaveLength(1);
      expect(parsed.types[0]!.params).toEqual([I32, I32]);
      expect(parsed.types[0]!.results).toEqual([I32]);
      expect(parsed.functions).toHaveLength(1);
      expect(parsed.functions[0]!.typeIdx).toBe(0);
      expect(parsed.exports).toHaveLength(1);
      expect(parsed.exports[0]!.name).toBe("add");
      expect(parsed.exports[0]!.kind).toBe(0); // func
      expect(parsed.memories).toHaveLength(1);
      expect(parsed.memories[0]!.min).toBe(1);
      expect(parsed.code).toHaveLength(1);
    });

    it("should parse symbol table from linking section", () => {
      const bytes = makeExporterModule("test");
      const parsed = parseObject("test", bytes);

      // Should have 1 function symbol (exported "add")
      const funcSymbols = parsed.symbols.filter(
        (s) => s.kind === SYMTAB_FUNCTION,
      );
      expect(funcSymbols.length).toBeGreaterThanOrEqual(1);

      const addSym = funcSymbols.find((s) => s.name === "add");
      expect(addSym).toBeDefined();
      expect(addSym!.flags & SYMBOL_EXPORTED).toBeTruthy();
    });

    it("should parse imports correctly", () => {
      const bytes = makeImporterModule("importer");
      const parsed = parseObject("importer", bytes);

      expect(parsed.imports).toHaveLength(1);
      expect(parsed.imports[0]!.module).toBe("env");
      expect(parsed.imports[0]!.name).toBe("add");
      expect(parsed.imports[0]!.kind).toBe(0); // func
      expect(parsed.imports[0]!.typeIdx).toBe(0);

      // Should have an undefined symbol for the import
      const undefinedSyms = parsed.symbols.filter(
        (s) => s.flags & SYMBOL_UNDEFINED,
      );
      expect(undefinedSyms.length).toBeGreaterThanOrEqual(1);
    });

    it("should reject invalid magic", () => {
      const bad = new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00]);
      expect(() => parseObject("bad", bad)).toThrow("Invalid wasm magic");
    });
  });

  describe("resolveSymbols", () => {
    it("should resolve imported function to exported function", () => {
      const exporter = parseObject("exporter", makeExporterModule("exporter"));
      const importer = parseObject("importer", makeImporterModule("importer"));

      const resolution = resolveSymbols([importer, exporter]);

      expect(resolution.errors).toHaveLength(0);
      expect(resolution.resolved.size).toBeGreaterThanOrEqual(1);

      // Find the resolved "add" symbol
      let foundAdd = false;
      for (const [key, value] of resolution.resolved) {
        if (value.name === "add") {
          foundAdd = true;
          expect(value.targetModule).toBe(1); // exporter is index 1
        }
      }
      expect(foundAdd).toBe(true);
    });

    it("should report unresolved symbols", () => {
      const importer = parseObject("importer", makeImporterModule("importer"));

      // Only the importer, no module provides "add"
      const resolution = resolveSymbols([importer]);

      expect(resolution.errors.length).toBeGreaterThan(0);
      expect(resolution.errors[0]).toContain("Unresolved symbol");
      expect(resolution.errors[0]).toContain("add");
    });
  });

  describe("link", () => {
    it("should link two modules where one imports from the other", () => {
      const objects = new Map<string, Uint8Array>();
      objects.set("exporter", makeExporterModule("exporter"));
      objects.set("importer", makeImporterModule("importer"));

      const result = link(objects, { validateIsolation: false });

      expect(result.success).toBe(true);
      expect(result.errors.filter((e) => e.severity === "error")).toHaveLength(0);
      expect(result.binary.length).toBeGreaterThan(8); // more than just magic+version

      // Verify it starts with wasm magic
      expect(result.binary[0]).toBe(0x00);
      expect(result.binary[1]).toBe(0x61);
      expect(result.binary[2]).toBe(0x73);
      expect(result.binary[3]).toBe(0x6d);
    });

    it("should handle three-module chain (A -> B -> C)", () => {
      // C exports "double" (i32) -> i32
      const moduleC = buildTestObjectWithNamedImports({
        name: "moduleC",
        types: [{ params: [I32], results: [I32] }],
        functions: [
          {
            typeIdx: 0,
            exported: true,
            name: "double",
            // local.get 0, local.get 0, i32.add
            body: [0x20, 0x00, 0x20, 0x00, 0x6a],
          },
        ],
        memories: [{ min: 1 }],
      });

      // B imports "double" from C, exports "quadruple"
      const moduleB = buildTestObjectWithNamedImports({
        name: "moduleB",
        types: [
          { params: [I32], results: [I32] }, // type 0: (i32) -> i32
        ],
        imports: [{ module: "env", name: "double", typeIdx: 0 }],
        functions: [
          {
            typeIdx: 0,
            exported: true,
            name: "quadruple",
            // local.get 0, call 0 (double), call 0 (double)
            body: [0x20, 0x00, 0x10, 0x00, 0x10, 0x00],
          },
        ],
        memories: [{ min: 1 }],
      });

      // A imports "quadruple" from B, exports "run"
      const moduleA = buildTestObjectWithNamedImports({
        name: "moduleA",
        types: [
          { params: [I32], results: [I32] }, // type 0: (i32) -> i32
          { params: [], results: [I32] }, // type 1: () -> i32
        ],
        imports: [{ module: "env", name: "quadruple", typeIdx: 0 }],
        functions: [
          {
            typeIdx: 1,
            exported: true,
            name: "run",
            // i32.const 5, call 0 (quadruple)
            body: [0x41, 0x05, 0x10, 0x00],
          },
        ],
        memories: [{ min: 1 }],
      });

      const objects = new Map<string, Uint8Array>();
      objects.set("moduleA", moduleA);
      objects.set("moduleB", moduleB);
      objects.set("moduleC", moduleC);

      const result = link(objects, { validateIsolation: false });

      expect(result.success).toBe(true);
      expect(result.errors.filter((e) => e.severity === "error")).toHaveLength(0);
      expect(result.binary.length).toBeGreaterThan(8);
    });

    it("should only export from entry module when specified", () => {
      const objects = new Map<string, Uint8Array>();
      objects.set("exporter", makeExporterModule("exporter"));
      objects.set("importer", makeImporterModule("importer"));

      const result = link(objects, {
        entry: "importer",
        validateIsolation: false,
      });

      expect(result.success).toBe(true);

      // Parse the output to check exports
      const output = parseObject("output", result.binary);
      const exportNames = output.exports.map((e) => e.name);

      // Only "callAdd" from the importer module should be exported
      expect(exportNames).toContain("callAdd");
      expect(exportNames).not.toContain("add");
    });

    it("should give each module its own memory (multi-memory)", () => {
      const objects = new Map<string, Uint8Array>();
      objects.set("exporter", makeExporterModule("exporter"));
      objects.set("importer", makeImporterModule("importer"));

      const result = link(objects, { validateIsolation: false });

      expect(result.success).toBe(true);

      // Parse output and check memory count
      const output = parseObject("output", result.binary);
      expect(output.memories).toHaveLength(2); // one per module
    });

    it("should generate WAT stub output", () => {
      const objects = new Map<string, Uint8Array>();
      objects.set("exporter", makeExporterModule("exporter"));

      const result = link(objects, { validateIsolation: false });

      expect(result.success).toBe(true);
      expect(result.wat).toContain("(module");
      expect(result.wat).toContain("exporter");
    });

    it("should report parse errors for invalid input", () => {
      const objects = new Map<string, Uint8Array>();
      objects.set("bad", new Uint8Array([0x00, 0x00, 0x00, 0x00]));

      const result = link(objects);

      expect(result.success).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]!.severity).toBe("error");
    });
  });

  describe("isolation report", () => {
    it("should include isolation report when validation is enabled", () => {
      const objects = new Map<string, Uint8Array>();
      objects.set("exporter", makeExporterModule("exporter"));
      objects.set("importer", makeImporterModule("importer"));

      const result = link(objects, { validateIsolation: true });

      expect(result.isolationReport).toBeDefined();
      expect(result.isolationReport.modules).toHaveLength(2);
    });
  });
});
