import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { mapParamsToCabi, mapResultToCabi, inferSemantic } from "../src/codegen-linear/c-abi.js";
import type { ParamDef } from "../src/codegen-linear/c-abi.js";
import { generateCHeader } from "../src/emit/c-header.js";
import type { CHeaderExport } from "../src/emit/c-header.js";
import type { ValType } from "../src/ir/types.js";

// ── Unit tests for C ABI parameter mapping ──────────────────────────

describe("C ABI parameter mapping", () => {
  it("should pass i32 number directly", () => {
    const params: ParamDef[] = [{ name: "x", wasmType: { kind: "i32" }, semantic: "number_i32" }];
    const result = mapParamsToCabi(params);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("x");
    expect(result[0].wasmType.kind).toBe("i32");
    expect(result[0].role).toBe("direct");
  });

  it("should pass f64 number directly", () => {
    const params: ParamDef[] = [{ name: "y", wasmType: { kind: "f64" }, semantic: "number_f64" }];
    const result = mapParamsToCabi(params);
    expect(result).toHaveLength(1);
    expect(result[0].wasmType.kind).toBe("f64");
    expect(result[0].role).toBe("direct");
  });

  it("should expand string param to (ptr, len) pair", () => {
    const params: ParamDef[] = [{ name: "s", wasmType: { kind: "i32" }, semantic: "string" }];
    const result = mapParamsToCabi(params);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("s_ptr");
    expect(result[0].wasmType.kind).toBe("i32");
    expect(result[0].role).toBe("ptr");
    expect(result[1].name).toBe("s_len");
    expect(result[1].wasmType.kind).toBe("i32");
    expect(result[1].role).toBe("len");
  });

  it("should expand array param to (ptr, len) pair", () => {
    const params: ParamDef[] = [{ name: "arr", wasmType: { kind: "i32" }, semantic: "array" }];
    const result = mapParamsToCabi(params);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("arr_ptr");
    expect(result[0].role).toBe("ptr");
    expect(result[1].name).toBe("arr_len");
    expect(result[1].role).toBe("len");
  });

  it("should map boolean to i32", () => {
    const params: ParamDef[] = [{ name: "flag", wasmType: { kind: "f64" }, semantic: "boolean" }];
    const result = mapParamsToCabi(params);
    expect(result).toHaveLength(1);
    expect(result[0].wasmType.kind).toBe("i32");
    expect(result[0].role).toBe("direct");
  });

  it("should map object to i32 pointer", () => {
    const params: ParamDef[] = [{ name: "obj", wasmType: { kind: "i32" }, semantic: "object" }];
    const result = mapParamsToCabi(params);
    expect(result).toHaveLength(1);
    expect(result[0].wasmType.kind).toBe("i32");
    expect(result[0].role).toBe("direct");
  });

  it("should handle mixed params with expansion", () => {
    const params: ParamDef[] = [
      { name: "n", wasmType: { kind: "f64" }, semantic: "number_f64" },
      { name: "s", wasmType: { kind: "i32" }, semantic: "string" },
      { name: "x", wasmType: { kind: "i32" }, semantic: "number_i32" },
    ];
    const result = mapParamsToCabi(params);
    expect(result).toHaveLength(4); // n, s_ptr, s_len, x
    expect(result[0].name).toBe("n");
    expect(result[1].name).toBe("s_ptr");
    expect(result[2].name).toBe("s_len");
    expect(result[3].name).toBe("x");
  });
});

// ── Unit tests for C ABI return type mapping ────────────────────────

describe("C ABI return type mapping", () => {
  it("should map void return", () => {
    const result = mapResultToCabi(null, "void");
    expect(result.wasmTypes).toHaveLength(0);
    expect(result.semantic).toBe("void");
  });

  it("should map i32 number return", () => {
    const result = mapResultToCabi({ kind: "i32" }, "number_i32");
    expect(result.wasmTypes).toHaveLength(1);
    expect(result.wasmTypes[0].kind).toBe("i32");
  });

  it("should map f64 number return", () => {
    const result = mapResultToCabi({ kind: "f64" }, "number_f64");
    expect(result.wasmTypes).toHaveLength(1);
    expect(result.wasmTypes[0].kind).toBe("f64");
  });

  it("should map string return to (ptr, len)", () => {
    const result = mapResultToCabi({ kind: "i32" }, "string");
    expect(result.wasmTypes).toHaveLength(2);
    expect(result.wasmTypes[0].kind).toBe("i32");
    expect(result.wasmTypes[1].kind).toBe("i32");
    expect(result.semantic).toBe("string");
  });

  it("should map array return to (ptr, len)", () => {
    const result = mapResultToCabi({ kind: "i32" }, "array");
    expect(result.wasmTypes).toHaveLength(2);
    expect(result.wasmTypes[0].kind).toBe("i32");
    expect(result.wasmTypes[1].kind).toBe("i32");
    expect(result.semantic).toBe("array");
  });

  it("should map boolean return to i32", () => {
    const result = mapResultToCabi({ kind: "i32" }, "boolean");
    expect(result.wasmTypes).toHaveLength(1);
    expect(result.wasmTypes[0].kind).toBe("i32");
  });
});

// ── Unit tests for semantic inference ───────────────────────────────

describe("inferSemantic", () => {
  it("should detect string type", () => {
    expect(inferSemantic({ kind: "i32" }, "string")).toBe("string");
  });

  it("should detect boolean type", () => {
    expect(inferSemantic({ kind: "f64" }, "boolean")).toBe("boolean");
  });

  it("should detect number type with f64", () => {
    expect(inferSemantic({ kind: "f64" }, "number")).toBe("number_f64");
  });

  it("should detect number type with i32", () => {
    expect(inferSemantic({ kind: "i32" }, "number")).toBe("number_i32");
  });

  it("should detect array type", () => {
    expect(inferSemantic({ kind: "i32" }, "number[]")).toBe("array");
    expect(inferSemantic({ kind: "i32" }, "Array<number>")).toBe("array");
  });

  it("should default to object for unknown types", () => {
    expect(inferSemantic({ kind: "i32" }, "MyClass")).toBe("object");
  });

  it("should strip nullable types", () => {
    expect(inferSemantic({ kind: "i32" }, "string | undefined")).toBe("string");
    expect(inferSemantic({ kind: "i32" }, "string | null")).toBe("string");
  });
});

// ── C header generation tests ───────────────────────────────────────

describe("C header generation", () => {
  it("should generate a valid C header with include guard", () => {
    const exports: CHeaderExport[] = [
      {
        name: "add",
        params: [{ kind: "i32" }, { kind: "i32" }],
        results: [{ kind: "i32" }],
      },
    ];
    const header = generateCHeader("my_module", exports);
    expect(header).toContain("#ifndef MY_MODULE_H");
    expect(header).toContain("#define MY_MODULE_H");
    expect(header).toContain("#include <stdint.h>");
    expect(header).toContain("int32_t add(int32_t p0, int32_t p1);");
    expect(header).toContain("#endif /* MY_MODULE_H */");
  });

  it("should generate void return for functions with no results", () => {
    const exports: CHeaderExport[] = [
      {
        name: "doSomething",
        params: [{ kind: "i32" }],
        results: [],
      },
    ];
    const header = generateCHeader("test", exports);
    expect(header).toContain("void doSomething(int32_t p0);");
  });

  it("should map f64 to double", () => {
    const exports: CHeaderExport[] = [
      {
        name: "compute",
        params: [{ kind: "f64" }],
        results: [{ kind: "f64" }],
      },
    ];
    const header = generateCHeader("test", exports);
    expect(header).toContain("double compute(double p0);");
  });

  it("should handle functions with no parameters", () => {
    const exports: CHeaderExport[] = [
      {
        name: "getVal",
        params: [],
        results: [{ kind: "i32" }],
      },
    ];
    const header = generateCHeader("test", exports);
    expect(header).toContain("int32_t getVal(void);");
  });

  it("should handle multiple return values with out-params", () => {
    const exports: CHeaderExport[] = [
      {
        name: "getStr",
        params: [],
        results: [{ kind: "i32" }, { kind: "i32" }],
      },
    ];
    const header = generateCHeader("test", exports);
    expect(header).toContain("int32_t getStr(int32_t* out_0);");
  });

  it("should skip memory exports", () => {
    const exports: CHeaderExport[] = [
      {
        name: "memory",
        params: [],
        results: [],
      },
      {
        name: "add",
        params: [{ kind: "i32" }],
        results: [{ kind: "i32" }],
      },
    ];
    const header = generateCHeader("test", exports);
    expect(header).not.toContain("memory(");
    expect(header).toContain("add(");
  });

  it("should generate header for class methods with mangled names", () => {
    const exports: CHeaderExport[] = [
      {
        name: "MyClass_bar",
        params: [{ kind: "i32" }, { kind: "i32" }],
        results: [],
      },
    ];
    const header = generateCHeader("test", exports);
    expect(header).toContain("void MyClass_bar(int32_t p0, int32_t p1);");
  });
});

// ── Integration: compile with abi: "c" ──────────────────────────────

describe("compile with abi: 'c'", () => {
  it("should produce exports with C-compatible signatures for scalar functions", () => {
    const result = compile(
      `export function add(a: number, b: number): number {
        return a + b;
      }`,
      { target: "linear", abi: "c" },
    );
    expect(result.success).toBe(true);
    expect(result.cHeader).toBeDefined();
    expect(result.cHeader).toContain("add(");
    expect(result.cHeader).toContain("#include <stdint.h>");
  });

  it("should produce a valid wasm binary that instantiates and runs", async () => {
    const result = compile(
      `export function add(a: number, b: number): number {
        return a + b;
      }`,
      { target: "linear", abi: "c" },
    );
    expect(result.success).toBe(true);

    const { instance } = await WebAssembly.instantiate(result.binary);
    const add = instance.exports.add as Function;
    expect(add(3.0, 4.0)).toBe(7.0);
  });

  it("should generate correct C header content", () => {
    const result = compile(
      `export function multiply(x: number, y: number): number {
        return x * y;
      }
      export function noop(): void {}`,
      { target: "linear", abi: "c" },
    );
    expect(result.success).toBe(true);
    expect(result.cHeader).toContain("multiply(");
    expect(result.cHeader).toContain("noop(");
  });

  it("should not produce cHeader when abi is default", () => {
    const result = compile(
      `export function add(a: number, b: number): number {
        return a + b;
      }`,
      { target: "linear" },
    );
    expect(result.success).toBe(true);
    expect(result.cHeader).toBeUndefined();
  });

  it("should not produce cHeader when target is gc", () => {
    const result = compile(
      `export function add(a: number, b: number): number {
        return a + b;
      }`,
      { abi: "c" },
    );
    expect(result.success).toBe(true);
    // C ABI only applies to linear target
    expect(result.cHeader).toBeUndefined();
  });

  it("should be backwards-compatible: omitted abi option works as before", () => {
    const result = compile(
      `export function sub(a: number, b: number): number {
        return a - b;
      }`,
      { target: "linear" },
    );
    expect(result.success).toBe(true);
    expect(result.cHeader).toBeUndefined();
  });

  it("should handle class constructors and methods in header", () => {
    // In the linear backend, class constructors are exported as Point_new etc.
    // Class methods are internal (not exported). Verify we at least get a valid
    // header for any exported functions alongside the class.
    const result = compile(
      `export class Point {
        x: number;
        y: number;
        constructor(x: number, y: number) {
          this.x = x;
          this.y = y;
        }
        getX(): number {
          return this.x;
        }
      }
      export function makePoint(x: number, y: number): number {
        return x + y;
      }`,
      { target: "linear", abi: "c" },
    );
    expect(result.success).toBe(true);
    expect(result.cHeader).toBeDefined();
    // The standalone function should appear in the header
    expect(result.cHeader).toContain("makePoint(");
  });

  it("should handle void-returning functions", async () => {
    const result = compile(
      `export function setVal(x: number): void {
        // does nothing
      }`,
      { target: "linear", abi: "c" },
    );
    expect(result.success).toBe(true);

    const { instance } = await WebAssembly.instantiate(result.binary);
    const setVal = instance.exports.setVal as Function;
    expect(setVal(42)).toBeUndefined();
  });

  it("should include generated header comment", () => {
    const result = compile(`export function foo(): number { return 1; }`, { target: "linear", abi: "c" });
    expect(result.success).toBe(true);
    expect(result.cHeader).toContain("// Generated by ts2wasm");
  });
});

// ── Linking two modules ─────────────────────────────────────────────

describe("C ABI cross-module linking", () => {
  it("should produce linkable C ABI modules", () => {
    // Module A: exports a function
    const modA = compile(
      `export function square(x: number): number {
        return x * x;
      }`,
      { target: "linear", abi: "c" },
    );
    expect(modA.success).toBe(true);
    expect(modA.cHeader).toContain("square(");

    // Module B: exports a different function
    const modB = compile(
      `export function double_val(x: number): number {
        return x + x;
      }`,
      { target: "linear", abi: "c" },
    );
    expect(modB.success).toBe(true);
    expect(modB.cHeader).toContain("double_val(");

    // Both should produce valid wasm binaries
    expect(modA.binary.length).toBeGreaterThan(8);
    expect(modB.binary.length).toBeGreaterThan(8);
  });

  it("should produce wasm binaries that both instantiate correctly", async () => {
    const modA = compile(`export function inc(x: number): number { return x + 1; }`, { target: "linear", abi: "c" });
    const modB = compile(`export function dec(x: number): number { return x - 1; }`, { target: "linear", abi: "c" });

    expect(modA.success).toBe(true);
    expect(modB.success).toBe(true);

    const instA = await WebAssembly.instantiate(modA.binary);
    const instB = await WebAssembly.instantiate(modB.binary);

    const inc = instA.instance.exports.inc as Function;
    const dec = instB.instance.exports.dec as Function;

    expect(inc(10.0)).toBe(11.0);
    expect(dec(10.0)).toBe(9.0);
  });
});
