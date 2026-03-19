import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function compileAndRun(source: string) {
  const result = compile(source, { fileName: "test.ts" });
  if (!result.binary || result.binary.length === 0) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return instance.exports as Record<string, Function>;
}

// Tolerance for polynomial approximations (inline Wasm, not native IEEE 754)
const EPSILON = 1e-3;

describe("Inline Math functions (no host imports)", () => {
  describe("Math.sin", () => {
    it("sin(0) = 0", async () => {
      const e = await compileAndRun(`export function test(): number { return Math.sin(0); }`);
      expect(e.test()).toBeCloseTo(0, 10);
    });

    it("sin(pi/2) = 1", async () => {
      const e = await compileAndRun(`export function test(): number { return Math.sin(Math.PI / 2); }`);
      expect(e.test()).toBeCloseTo(1, 5);
    });

    it("sin(pi) ~ 0", async () => {
      const e = await compileAndRun(`export function test(): number { return Math.sin(Math.PI); }`);
      expect(Math.abs(e.test())).toBeLessThan(EPSILON);
    });

    it("sin(NaN) = NaN", async () => {
      const e = await compileAndRun(`export function test(): number { return Math.sin(NaN); }`);
      expect(e.test()).toBeNaN();
    });
  });

  describe("Math.cos", () => {
    it("cos(0) = 1", async () => {
      const e = await compileAndRun(`export function test(): number { return Math.cos(0); }`);
      expect(e.test()).toBeCloseTo(1, 10);
    });

    it("cos(pi) = -1", async () => {
      const e = await compileAndRun(`export function test(): number { return Math.cos(Math.PI); }`);
      expect(e.test()).toBeCloseTo(-1, 3);
    });

    it("cos(pi/2) ~ 0", async () => {
      const e = await compileAndRun(`export function test(): number { return Math.cos(Math.PI / 2); }`);
      expect(Math.abs(e.test())).toBeLessThan(EPSILON);
    });
  });

  describe("Math.tan", () => {
    it("tan(0) = 0", async () => {
      const e = await compileAndRun(`export function test(): number { return Math.tan(0); }`);
      expect(e.test()).toBeCloseTo(0, 10);
    });

    it("tan(pi/4) = 1", async () => {
      const e = await compileAndRun(`export function test(): number { return Math.tan(Math.PI / 4); }`);
      expect(e.test()).toBeCloseTo(1, 5);
    });
  });

  describe("Math.exp", () => {
    it("exp(0) = 1", async () => {
      const e = await compileAndRun(`export function test(): number { return Math.exp(0); }`);
      expect(e.test()).toBe(1);
    });

    it("exp(1) ~ E", async () => {
      const e = await compileAndRun(`export function test(): number { return Math.exp(1); }`);
      expect(e.test()).toBeCloseTo(Math.E, 5);
    });

    it("exp(-1) ~ 1/E", async () => {
      const e = await compileAndRun(`export function test(): number { return Math.exp(-1); }`);
      expect(e.test()).toBeCloseTo(1 / Math.E, 5);
    });

    it("exp(10) ~ 22026.47", async () => {
      const e = await compileAndRun(`export function test(): number { return Math.exp(10); }`);
      expect(e.test()).toBeCloseTo(Math.exp(10), 0);
    });

    it("exp(NaN) = NaN", async () => {
      const e = await compileAndRun(`export function test(): number { return Math.exp(NaN); }`);
      expect(e.test()).toBeNaN();
    });

    it("exp(Infinity) = Infinity", async () => {
      const e = await compileAndRun(`export function test(): number { return Math.exp(Infinity); }`);
      expect(e.test()).toBe(Infinity);
    });
  });

  describe("Math.log", () => {
    it("log(1) = 0", async () => {
      const e = await compileAndRun(`export function test(): number { return Math.log(1); }`);
      expect(e.test()).toBe(0);
    });

    it("log(E) ~ 1", async () => {
      const e = await compileAndRun(`export function test(): number { return Math.log(Math.E); }`);
      expect(e.test()).toBeCloseTo(1, 5);
    });

    it("log(0) = -Infinity", async () => {
      const e = await compileAndRun(`export function test(): number { return Math.log(0); }`);
      expect(e.test()).toBe(-Infinity);
    });

    it("log(-1) = NaN", async () => {
      const e = await compileAndRun(`export function test(): number { return Math.log(-1); }`);
      expect(e.test()).toBeNaN();
    });
  });

  describe("Math.atan", () => {
    it("atan(0) = 0", async () => {
      const e = await compileAndRun(`export function test(): number { return Math.atan(0); }`);
      expect(e.test()).toBeCloseTo(0, 10);
    });

    it("atan(1) ~ pi/4", async () => {
      const e = await compileAndRun(`export function test(): number { return Math.atan(1); }`);
      expect(e.test()).toBeCloseTo(Math.PI / 4, 5);
    });

    it("atan(Infinity) = pi/2", async () => {
      const e = await compileAndRun(`export function test(): number { return Math.atan(Infinity); }`);
      expect(e.test()).toBeCloseTo(Math.PI / 2, 10);
    });
  });

  describe("Math.pow (** operator)", () => {
    it("2 ** 10 = 1024", async () => {
      const e = await compileAndRun(`export function test(): number { return 2 ** 10; }`);
      expect(e.test()).toBeCloseTo(1024, 0);
    });

    it("2 ** 0.5 ~ sqrt(2)", async () => {
      const e = await compileAndRun(`export function test(): number { return 2 ** 0.5; }`);
      expect(e.test()).toBeCloseTo(Math.SQRT2, 5);
    });

    it("Math.pow(2, -1) = 0.5", async () => {
      const e = await compileAndRun(`export function test(): number { return Math.pow(2, -1); }`);
      expect(e.test()).toBe(0.5);
    });
  });

  describe("Math.log2 / Math.log10", () => {
    it("log2(8) ~ 3", async () => {
      const e = await compileAndRun(`export function test(): number { return Math.log2(8); }`);
      expect(e.test()).toBeCloseTo(3, 5);
    });

    it("log10(1000) ~ 3", async () => {
      const e = await compileAndRun(`export function test(): number { return Math.log10(1000); }`);
      expect(e.test()).toBeCloseTo(3, 5);
    });
  });

  describe("Math.asin / Math.acos / Math.atan2", () => {
    it("asin(1) = pi/2", async () => {
      const e = await compileAndRun(`export function test(): number { return Math.asin(1); }`);
      expect(e.test()).toBeCloseTo(Math.PI / 2, 5);
    });

    it("acos(0) = pi/2", async () => {
      const e = await compileAndRun(`export function test(): number { return Math.acos(0); }`);
      expect(e.test()).toBeCloseTo(Math.PI / 2, 5);
    });

    it("atan2(1, 1) = pi/4", async () => {
      const e = await compileAndRun(`export function test(): number { return Math.atan2(1, 1); }`);
      expect(e.test()).toBeCloseTo(Math.PI / 4, 5);
    });
  });

  describe("Hyperbolic functions", () => {
    it("sinh(0) = 0", async () => {
      const e = await compileAndRun(`export function test(): number { return Math.sinh(0); }`);
      expect(e.test()).toBeCloseTo(0, 10);
    });

    it("cosh(0) = 1", async () => {
      const e = await compileAndRun(`export function test(): number { return Math.cosh(0); }`);
      expect(e.test()).toBeCloseTo(1, 10);
    });

    it("tanh(0) = 0", async () => {
      const e = await compileAndRun(`export function test(): number { return Math.tanh(0); }`);
      expect(e.test()).toBeCloseTo(0, 10);
    });
  });

  describe("Math.cbrt", () => {
    it("cbrt(27) = 3", async () => {
      const e = await compileAndRun(`export function test(): number { return Math.cbrt(27); }`);
      expect(e.test()).toBeCloseTo(3, 5);
    });

    it("cbrt(-8) = -2", async () => {
      const e = await compileAndRun(`export function test(): number { return Math.cbrt(-8); }`);
      expect(e.test()).toBeCloseTo(-2, 5);
    });
  });

  describe("Math.expm1 / Math.log1p", () => {
    it("expm1(0) = 0", async () => {
      const e = await compileAndRun(`export function test(): number { return Math.expm1(0); }`);
      expect(Math.abs(e.test())).toBeLessThan(EPSILON);
    });

    it("expm1(NaN) = NaN", async () => {
      const e = await compileAndRun(`export function test(): number { return Math.expm1(NaN); }`);
      expect(e.test()).toBeNaN();
    });

    it("expm1(-Infinity) = -1", async () => {
      const e = await compileAndRun(`export function test(): number { return Math.expm1(-Infinity); }`);
      expect(e.test()).toBe(-1);
    });

    it("expm1(+Infinity) = +Infinity", async () => {
      const e = await compileAndRun(`export function test(): number { return Math.expm1(Infinity); }`);
      expect(e.test()).toBe(Infinity);
    });

    it("expm1(-0) preserves negative zero", async () => {
      const e = await compileAndRun(`export function test(): number { return 1 / Math.expm1(-0); }`);
      expect(e.test()).toBe(-Infinity);
    });

    it("expm1(+0) preserves positive zero", async () => {
      const e = await compileAndRun(`export function test(): number { return 1 / Math.expm1(0); }`);
      expect(e.test()).toBe(Infinity);
    });

    it("log1p(0) = 0", async () => {
      const e = await compileAndRun(`export function test(): number { return Math.log1p(0); }`);
      expect(Math.abs(e.test())).toBeLessThan(EPSILON);
    });
  });

  describe("Math.atanh special values", () => {
    it("atanh(NaN) = NaN", async () => {
      const e = await compileAndRun(`export function test(): number { return Math.atanh(NaN); }`);
      expect(e.test()).toBeNaN();
    });

    it("atanh(1) = +Infinity", async () => {
      const e = await compileAndRun(`export function test(): number { return Math.atanh(1); }`);
      expect(e.test()).toBe(Infinity);
    });

    it("atanh(-1) = -Infinity", async () => {
      const e = await compileAndRun(`export function test(): number { return Math.atanh(-1); }`);
      expect(e.test()).toBe(-Infinity);
    });

    it("atanh(2) = NaN (|x| > 1)", async () => {
      const e = await compileAndRun(`export function test(): number { return Math.atanh(2); }`);
      expect(e.test()).toBeNaN();
    });

    it("atanh(-0) preserves negative zero", async () => {
      const e = await compileAndRun(`export function test(): number { return 1 / Math.atanh(-0); }`);
      expect(e.test()).toBe(-Infinity);
    });

    it("atanh(+0) preserves positive zero", async () => {
      const e = await compileAndRun(`export function test(): number { return 1 / Math.atanh(0); }`);
      expect(e.test()).toBe(Infinity);
    });
  });

  describe("No host imports for Math methods", () => {
    it("compile result should not contain Math_ imports (except random)", async () => {
      const result = compile(`
        export function test(): number {
          return Math.sin(1) + Math.cos(1) + Math.exp(1) + Math.log(2) + Math.tan(1) + Math.atan(1);
        }
      `, { fileName: "test.ts" });

      // Check that no Math_ imports are in the import list
      const mathImports = result.imports.filter(i => i.name.startsWith("Math_"));
      expect(mathImports).toHaveLength(0);
    });
  });
});
