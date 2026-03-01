import { describe, it, expect } from "vitest";
import {
  buildTestObjectWithNamedImports,
  SYMBOL_EXPORTED,
  SYMBOL_UNDEFINED,
  SYMBOL_EXPLICIT_NAME,
  SYMBOL_BINDING_LOCAL,
  SYMTAB_FUNCTION,
  SYMTAB_GLOBAL,
} from "./link-helpers.js";
import { parseObject } from "../src/link/reader.js";
import { resolveSymbols } from "../src/link/resolver.js";
import { validateIsolation } from "../src/link/isolation.js";

// ── Helpers ───────────────────────────────────────────────────────

const I32 = 0x7f;

function makeCleanExporter(): Uint8Array {
  return buildTestObjectWithNamedImports({
    name: "exporter",
    types: [{ params: [I32, I32], results: [I32] }],
    functions: [
      {
        typeIdx: 0,
        exported: true,
        name: "add",
        body: [0x20, 0x00, 0x20, 0x01, 0x6a],
      },
    ],
    memories: [{ min: 1 }],
  });
}

function makeCleanImporter(): Uint8Array {
  return buildTestObjectWithNamedImports({
    name: "importer",
    types: [
      { params: [I32, I32], results: [I32] },
      { params: [], results: [I32] },
    ],
    imports: [{ module: "env", name: "add", typeIdx: 0 }],
    functions: [
      {
        typeIdx: 1,
        exported: true,
        name: "callAdd",
        body: [0x41, 0x03, 0x41, 0x04, 0x10, 0x00],
      },
    ],
    memories: [{ min: 1 }],
  });
}

// ── Tests ─────────────────────────────────────────────────────────

describe("isolation validation", () => {
  it("should pass all properties for clean modules", () => {
    const exporter = parseObject("exporter", makeCleanExporter());
    const importer = parseObject("importer", makeCleanImporter());

    const resolution = resolveSymbols([importer, exporter]);
    expect(resolution.errors).toHaveLength(0);

    const report = validateIsolation([importer, exporter], resolution);

    expect(report.modules).toEqual(["importer", "exporter"]);
    expect(report.properties.importExportOnly).toBe(true);
    expect(report.properties.noSharedGlobals).toBe(true);
    expect(report.properties.memoryIsolation).toBe(true);
    expect(report.properties.noPrivateFunctionAccess).toBe(true);
    expect(report.properties.tableIsolation).toBe(true);
    expect(report.violations).toHaveLength(0);
  });

  it("should detect private function access violation", () => {
    // Exporter has a local-binding function (private)
    const exporterBytes = buildTestObjectWithNamedImports({
      name: "exporter",
      types: [{ params: [I32], results: [I32] }],
      functions: [
        {
          typeIdx: 0,
          exported: false,
          name: "privateFunc",
          body: [0x20, 0x00],
        },
      ],
      // Override: make the function symbol local-binding but still visible
      // (normally this would be caught as "unresolved", but we'll force it
      // into the resolution for testing)
      extraSymbols: [],
    });

    // We need to manually tweak the parsed object to have the right flags
    const exporter = parseObject("exporter", exporterBytes);
    // Find the privateFunc symbol and set BINDING_LOCAL
    for (const sym of exporter.symbols) {
      if (sym.name === "privateFunc") {
        sym.flags = SYMBOL_BINDING_LOCAL;
      }
    }

    // Importer tries to call privateFunc
    const importerBytes = buildTestObjectWithNamedImports({
      name: "importer",
      types: [
        { params: [I32], results: [I32] },
        { params: [], results: [I32] },
      ],
      imports: [{ module: "env", name: "privateFunc", typeIdx: 0 }],
      functions: [
        {
          typeIdx: 1,
          exported: true,
          name: "caller",
          body: [0x41, 0x05, 0x10, 0x00],
        },
      ],
    });
    const importer = parseObject("importer", importerBytes);

    // Manually create a resolution that targets the private function
    const resolution = resolveSymbols([importer, exporter]);

    // Since BINDING_LOCAL should prevent resolution normally, we'll
    // manually add the resolution for testing the isolation check
    const importSymIdx = importer.symbols.findIndex(
      (s) =>
        s.name === "privateFunc" && s.flags & SYMBOL_UNDEFINED,
    );
    if (importSymIdx >= 0) {
      resolution.resolved.set(`0:${importSymIdx}`, {
        targetModule: 1,
        targetIndex: 0,
        name: "privateFunc",
      });
      // Clear errors since we forced resolution
      resolution.errors.length = 0;
    }

    const report = validateIsolation(
      [importer, exporter],
      resolution,
    );

    expect(report.properties.noPrivateFunctionAccess).toBe(false);
    expect(report.violations.length).toBeGreaterThan(0);

    const violation = report.violations.find(
      (v) => v.property === "noPrivateFunctionAccess",
    );
    expect(violation).toBeDefined();
    expect(violation!.module).toBe("importer");
    expect(violation!.targetModule).toBe("exporter");
    expect(violation!.symbol).toBe("privateFunc");
    expect(violation!.message).toContain("private");
    expect(violation!.message).toContain("importer");
    expect(violation!.message).toContain("exporter");
  });

  it("should detect shared mutable globals violation", () => {
    // Two modules define the same mutable global
    const moduleA = buildTestObjectWithNamedImports({
      name: "moduleA",
      types: [{ params: [], results: [] }],
      functions: [],
      globals: [
        {
          type: I32,
          mutable: true,
          name: "sharedCounter",
          exported: true,
        },
      ],
    });

    const moduleB = buildTestObjectWithNamedImports({
      name: "moduleB",
      types: [{ params: [], results: [] }],
      functions: [],
      globals: [
        {
          type: I32,
          mutable: true,
          name: "sharedCounter",
          exported: true,
        },
      ],
    });

    const parsedA = parseObject("moduleA", moduleA);
    const parsedB = parseObject("moduleB", moduleB);

    const resolution = resolveSymbols([parsedA, parsedB]);
    const report = validateIsolation(
      [parsedA, parsedB],
      resolution,
    );

    expect(report.properties.noSharedGlobals).toBe(false);
    expect(report.violations.length).toBeGreaterThan(0);

    const violation = report.violations.find(
      (v) => v.property === "noSharedGlobals",
    );
    expect(violation).toBeDefined();
    expect(violation!.symbol).toBe("sharedCounter");
    expect(violation!.message).toContain("sharedCounter");
    expect(violation!.message).toContain("moduleA");
    expect(violation!.message).toContain("moduleB");
  });

  it("should pass noSharedGlobals when globals are immutable", () => {
    const moduleA = buildTestObjectWithNamedImports({
      name: "moduleA",
      types: [],
      globals: [
        {
          type: I32,
          mutable: false, // immutable
          name: "constant",
          exported: true,
        },
      ],
    });

    const moduleB = buildTestObjectWithNamedImports({
      name: "moduleB",
      types: [],
      globals: [
        {
          type: I32,
          mutable: false, // immutable
          name: "constant",
          exported: true,
        },
      ],
    });

    const parsedA = parseObject("moduleA", moduleA);
    const parsedB = parseObject("moduleB", moduleB);

    const resolution = resolveSymbols([parsedA, parsedB]);
    const report = validateIsolation(
      [parsedA, parsedB],
      resolution,
    );

    expect(report.properties.noSharedGlobals).toBe(true);
    const globalViolations = report.violations.filter(
      (v) => v.property === "noSharedGlobals",
    );
    expect(globalViolations).toHaveLength(0);
  });

  it("should pass all properties when modules only use imports/exports", () => {
    const exporter = parseObject("exporter", makeCleanExporter());
    const importer = parseObject("importer", makeCleanImporter());

    const resolution = resolveSymbols([importer, exporter]);
    const report = validateIsolation(
      [importer, exporter],
      resolution,
    );

    expect(report.properties.importExportOnly).toBe(true);
    expect(report.properties.noSharedGlobals).toBe(true);
    expect(report.properties.memoryIsolation).toBe(true);
    expect(report.properties.noPrivateFunctionAccess).toBe(true);
    expect(report.properties.tableIsolation).toBe(true);
  });

  it("should detect import/export-only violation when referencing non-exported symbol", () => {
    // Exporter has a function that is NOT marked as exported
    const exporterBytes = buildTestObjectWithNamedImports({
      name: "exporter",
      types: [{ params: [I32], results: [I32] }],
      functions: [
        {
          typeIdx: 0,
          exported: false, // not exported
          name: "internalFunc",
          body: [0x20, 0x00],
        },
      ],
    });

    const exporter = parseObject("exporter", exporterBytes);

    // Importer tries to use internalFunc
    const importerBytes = buildTestObjectWithNamedImports({
      name: "importer",
      types: [
        { params: [I32], results: [I32] },
        { params: [], results: [I32] },
      ],
      imports: [{ module: "env", name: "internalFunc", typeIdx: 0 }],
      functions: [
        {
          typeIdx: 1,
          exported: true,
          name: "caller",
          body: [0x41, 0x05, 0x10, 0x00],
        },
      ],
    });
    const importer = parseObject("importer", importerBytes);

    // Force a resolution (normally this would fail because non-exported
    // non-local symbols can still be resolved by the resolver)
    const resolution = resolveSymbols([importer, exporter]);

    // If the symbol was resolved (resolver doesn't check EXPORTED flag,
    // only isolation does), manually verify
    const importSymIdx = importer.symbols.findIndex(
      (s) =>
        s.name === "internalFunc" &&
        s.flags & SYMBOL_UNDEFINED,
    );
    if (
      importSymIdx >= 0 &&
      !resolution.resolved.has(`0:${importSymIdx}`)
    ) {
      // Force resolution for test purposes
      resolution.resolved.set(`0:${importSymIdx}`, {
        targetModule: 1,
        targetIndex: 0,
        name: "internalFunc",
      });
      resolution.errors.length = 0;
    }

    const report = validateIsolation(
      [importer, exporter],
      resolution,
    );

    expect(report.properties.importExportOnly).toBe(false);
    const violation = report.violations.find(
      (v) => v.property === "importExportOnly",
    );
    expect(violation).toBeDefined();
    expect(violation!.module).toBe("importer");
    expect(violation!.targetModule).toBe("exporter");
    expect(violation!.symbol).toBe("internalFunc");
    expect(violation!.message).toContain("not marked as exported");
  });

  it("should include module names and symbol names in all violation messages", () => {
    // Create a scenario with multiple violation types
    const moduleA = buildTestObjectWithNamedImports({
      name: "moduleA",
      types: [],
      globals: [
        {
          type: I32,
          mutable: true,
          name: "counter",
          exported: true,
        },
      ],
    });

    const moduleB = buildTestObjectWithNamedImports({
      name: "moduleB",
      types: [],
      globals: [
        {
          type: I32,
          mutable: true,
          name: "counter",
          exported: true,
        },
      ],
    });

    const parsedA = parseObject("moduleA", moduleA);
    const parsedB = parseObject("moduleB", moduleB);

    const resolution = resolveSymbols([parsedA, parsedB]);
    const report = validateIsolation(
      [parsedA, parsedB],
      resolution,
    );

    for (const violation of report.violations) {
      // Every violation should mention module names
      expect(violation.module).toBeTruthy();
      expect(violation.targetModule).toBeTruthy();
      expect(violation.symbol).toBeTruthy();
      // The message should contain the symbol name
      expect(violation.message).toContain(violation.symbol);
    }
  });

  it("should detect memory isolation issue if module has multiple memories", () => {
    // Build a module with 2 memories (abnormal case)
    const weirdModule = buildTestObjectWithNamedImports({
      name: "weirdModule",
      types: [],
      memories: [{ min: 1 }, { min: 2 }],
    });

    const parsed = parseObject("weirdModule", weirdModule);
    const resolution = resolveSymbols([parsed]);
    const report = validateIsolation([parsed], resolution);

    expect(report.properties.memoryIsolation).toBe(false);
    const violation = report.violations.find(
      (v) => v.property === "memoryIsolation",
    );
    expect(violation).toBeDefined();
    expect(violation!.module).toBe("weirdModule");
    expect(violation!.message).toContain("2 memories");
  });
});
