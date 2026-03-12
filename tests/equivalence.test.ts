import { describe, it, expect } from "vitest";
import { compile, type CompileResult } from "../src/index.js";
import { buildStringConstants } from "../src/runtime.js";
import ts from "typescript";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const jsStringPolyfill = {
  concat: (a: string, b: string) => a + b,
  length: (s: string) => s.length,
  equals: (a: string, b: string) => (a === b ? 1 : 0),
  substring: (s: string, start: number, end: number) =>
    s.substring(start, end),
  charCodeAt: (s: string, i: number) => s.charCodeAt(i),
};

/**
 * Build the full WebAssembly.Imports for a compiled result,
 * including env stubs, Math host imports, string constants,
 * and wasm:js-string polyfill.
 */
function buildImports(result: CompileResult): WebAssembly.Imports {
  const env: Record<string, Function> = {
    console_log_number: () => {},
    console_log_string: () => {},
    console_log_bool: () => {},
    Math_sin: Math.sin,
    Math_cos: Math.cos,
    Math_tan: Math.tan,
    Math_asin: Math.asin,
    Math_acos: Math.acos,
    Math_atan: Math.atan,
    Math_atan2: Math.atan2,
    Math_exp: Math.exp,
    Math_log: Math.log,
    Math_log2: Math.log2,
    Math_log10: Math.log10,
    Math_pow: Math.pow,
    Math_random: Math.random,
    Math_acosh: Math.acosh,
    Math_asinh: Math.asinh,
    Math_atanh: Math.atanh,
    Math_cbrt: Math.cbrt,
    Math_expm1: Math.expm1,
    Math_log1p: Math.log1p,
    number_toString: (v: number) => String(v),
    __typeof_number: (v: unknown) => (typeof v === "number" ? 1 : 0),
    __typeof_string: (v: unknown) => (typeof v === "string" ? 1 : 0),
    __typeof_boolean: (v: unknown) => (typeof v === "boolean" ? 1 : 0),
    __typeof: (v: unknown) => typeof v,
    __is_truthy: (v: unknown) => (v ? 1 : 0),
    parseFloat: (s: any) => parseFloat(String(s)),
    string_compare: (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0),
    __unbox_number: (v: unknown) => Number(v),
    __unbox_boolean: (v: unknown) => (v ? 1 : 0),
    __box_number: (v: number) => v,
    __box_boolean: (v: number) => Boolean(v),
    __make_callback: () => null,
  };
  return {
    env,
    "wasm:js-string": jsStringPolyfill,
    string_constants: buildStringConstants(result.stringPool),
  } as WebAssembly.Imports;
}

/**
 * Compile TS source to Wasm, instantiate it, and return exports.
 */
async function compileToWasm(source: string) {
  const result = compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
  const { instance } = await WebAssembly.instantiate(
    result.binary,
    buildImports(result),
  );
  return instance.exports as Record<string, Function>;
}

/**
 * Transpile TS source to JS and evaluate it, returning exported functions.
 * Uses TypeScript's transpileModule to strip types, then evaluates as JS.
 */
function evaluateAsJs(source: string): Record<string, Function> {
  const jsOutput = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  });

  const exports: Record<string, unknown> = {};
  const module = { exports };
  const fn = new Function("exports", "module", "Math", jsOutput.outputText);
  fn(exports, module, Math);
  return exports as Record<string, Function>;
}

/**
 * Test that Wasm output matches native JS output for a set of inputs.
 */
async function assertEquivalent(
  source: string,
  testCases: { fn: string; args: unknown[]; approx?: boolean }[],
) {
  const wasmExports = await compileToWasm(source);
  const jsExports = evaluateAsJs(source);

  for (const { fn, args, approx } of testCases) {
    const wasmResult = wasmExports[fn]!(...args);
    const jsResult = jsExports[fn]!(...args);

    if (approx) {
      expect(wasmResult).toBeCloseTo(jsResult as number, 10);
    } else {
      expect(wasmResult).toBe(jsResult);
    }
  }
}

describe("TS ↔ Wasm equivalence", () => {
  it("basic arithmetic", async () => {
    await assertEquivalent(
      `
      export function add(a: number, b: number): number { return a + b; }
      export function sub(a: number, b: number): number { return a - b; }
      export function mul(a: number, b: number): number { return a * b; }
      export function div(a: number, b: number): number { return a / b; }
      `,
      [
        { fn: "add", args: [2, 3] },
        { fn: "add", args: [-1, 1] },
        { fn: "add", args: [0.1, 0.2], approx: true },
        { fn: "sub", args: [10, 3] },
        { fn: "mul", args: [4, 5] },
        { fn: "mul", args: [-3, 7] },
        { fn: "div", args: [10, 2] },
        { fn: "div", args: [7, 3], approx: true },
      ],
    );
  });

  it("comparison and branching", async () => {
    await assertEquivalent(
      `
      export function max(a: number, b: number): number {
        if (a > b) return a;
        return b;
      }
      export function clamp(x: number, lo: number, hi: number): number {
        if (x < lo) return lo;
        if (x > hi) return hi;
        return x;
      }
      `,
      [
        { fn: "max", args: [3, 7] },
        { fn: "max", args: [10, 2] },
        { fn: "max", args: [5, 5] },
        { fn: "clamp", args: [5, 0, 10] },
        { fn: "clamp", args: [-3, 0, 10] },
        { fn: "clamp", args: [15, 0, 10] },
      ],
    );
  });

  it("loops", async () => {
    await assertEquivalent(
      `
      export function sum(n: number): number {
        let result: number = 0;
        let i: number = 1;
        while (i <= n) {
          result = result + i;
          i = i + 1;
        }
        return result;
      }
      export function factorial(n: number): number {
        let result: number = 1;
        for (let i: number = 2; i <= n; i = i + 1) {
          result = result * i;
        }
        return result;
      }
      `,
      [
        { fn: "sum", args: [0] },
        { fn: "sum", args: [1] },
        { fn: "sum", args: [10] },
        { fn: "sum", args: [100] },
        { fn: "factorial", args: [0] },
        { fn: "factorial", args: [1] },
        { fn: "factorial", args: [5] },
        { fn: "factorial", args: [10] },
      ],
    );
  });

  it("recursion", async () => {
    await assertEquivalent(
      `
      export function fib(n: number): number {
        if (n <= 1) return n;
        return fib(n - 1) + fib(n - 2);
      }
      `,
      [
        { fn: "fib", args: [0] },
        { fn: "fib", args: [1] },
        { fn: "fib", args: [5] },
        { fn: "fib", args: [10] },
      ],
    );
  });

  it("ternary expressions", async () => {
    await assertEquivalent(
      `
      export function abs(x: number): number {
        return x >= 0 ? x : -x;
      }
      export function sign(x: number): number {
        return x > 0 ? 1 : x < 0 ? -1 : 0;
      }
      `,
      [
        { fn: "abs", args: [-5] },
        { fn: "abs", args: [3] },
        { fn: "abs", args: [0] },
        { fn: "sign", args: [10] },
        { fn: "sign", args: [-7] },
        { fn: "sign", args: [0] },
      ],
    );
  });

  it("Math builtins (native wasm)", async () => {
    await assertEquivalent(
      `
      export function sqrtVal(x: number): number { return Math.sqrt(x); }
      export function absVal(x: number): number { return Math.abs(x); }
      export function floorVal(x: number): number { return Math.floor(x); }
      export function ceilVal(x: number): number { return Math.ceil(x); }
      export function roundVal(x: number): number { return Math.round(x); }
      export function truncVal(x: number): number { return Math.trunc(x); }
      export function minVal(a: number, b: number): number { return Math.min(a, b); }
      export function maxVal(a: number, b: number): number { return Math.max(a, b); }
      `,
      [
        { fn: "sqrtVal", args: [16] },
        { fn: "sqrtVal", args: [2], approx: true },
        { fn: "absVal", args: [-5] },
        { fn: "absVal", args: [3] },
        { fn: "floorVal", args: [3.7] },
        { fn: "floorVal", args: [-2.3] },
        { fn: "ceilVal", args: [3.2] },
        { fn: "ceilVal", args: [-2.8] },
        { fn: "roundVal", args: [3.7] },
        { fn: "roundVal", args: [3.2] },
        { fn: "truncVal", args: [3.7] },
        { fn: "truncVal", args: [-3.7] },
        { fn: "minVal", args: [3, 7] },
        { fn: "maxVal", args: [3, 7] },
      ],
    );
  });

  it("Math.round negative zero preservation (#87)", async () => {
    // Use 1/Math.round(x) to distinguish -0 from +0: 1/-0 === -Infinity
    await assertEquivalent(
      `
      export function roundRecip(x: number): number { return 1 / Math.round(x); }
      export function roundNeg05(): number { return 1 / Math.round(-0.5); }
      export function roundNeg025(): number { return 1 / Math.round(-0.25); }
      `,
      [
        { fn: "roundRecip", args: [-0.25] },
        { fn: "roundRecip", args: [-0.5] },
        { fn: "roundNeg05", args: [] },
        { fn: "roundNeg025", args: [] },
      ],
    );
  });

  it("Math builtins (host-imported)", async () => {
    await assertEquivalent(
      `
      export function sinVal(x: number): number { return Math.sin(x); }
      export function cosVal(x: number): number { return Math.cos(x); }
      export function expVal(x: number): number { return Math.exp(x); }
      export function logVal(x: number): number { return Math.log(x); }
      export function powVal(b: number, e: number): number { return Math.pow(b, e); }
      `,
      [
        { fn: "sinVal", args: [0], approx: true },
        { fn: "sinVal", args: [Math.PI / 2], approx: true },
        { fn: "cosVal", args: [0], approx: true },
        { fn: "cosVal", args: [Math.PI], approx: true },
        { fn: "expVal", args: [0] },
        { fn: "expVal", args: [1], approx: true },
        { fn: "logVal", args: [1] },
        { fn: "logVal", args: [Math.E], approx: true },
        { fn: "powVal", args: [2, 10] },
        { fn: "powVal", args: [3, 3] },
      ],
    );
  });

  it("compound algorithms", async () => {
    await assertEquivalent(
      `
      export function gcd(a: number, b: number): number {
        while (b !== 0) {
          let temp: number = b;
          b = a - Math.floor(a / b) * b;
          a = temp;
        }
        return a;
      }
      export function isPrime(n: number): number {
        if (n <= 1) return 0;
        let i: number = 2;
        while (i * i <= n) {
          if (n - Math.floor(n / i) * i === 0) return 0;
          i = i + 1;
        }
        return 1;
      }
      `,
      [
        { fn: "gcd", args: [12, 8] },
        { fn: "gcd", args: [15, 5] },
        { fn: "gcd", args: [17, 13] },
        { fn: "gcd", args: [100, 75] },
        { fn: "isPrime", args: [1] },
        { fn: "isPrime", args: [2] },
        { fn: "isPrime", args: [7] },
        { fn: "isPrime", args: [4] },
        { fn: "isPrime", args: [13] },
        { fn: "isPrime", args: [100] },
      ],
    );
  });

  it("nested control flow", async () => {
    await assertEquivalent(
      `
      export function classify(x: number): number {
        if (x > 0) {
          if (x > 100) {
            return 2;
          }
          return 1;
        } else {
          if (x < -100) {
            return -2;
          }
          return -1;
        }
      }
      `,
      [
        { fn: "classify", args: [50] },
        { fn: "classify", args: [150] },
        { fn: "classify", args: [-50] },
        { fn: "classify", args: [-150] },
        { fn: "classify", args: [0] },
      ],
    );
  });

  it("lerp / smooth interpolation", async () => {
    await assertEquivalent(
      `
      export function lerp(a: number, b: number, t: number): number {
        return a + (b - a) * t;
      }
      export function smoothstep(edge0: number, edge1: number, x: number): number {
        let t: number = (x - edge0) / (edge1 - edge0);
        if (t < 0) t = 0;
        if (t > 1) t = 1;
        return t * t * (3 - 2 * t);
      }
      `,
      [
        { fn: "lerp", args: [0, 10, 0.5] },
        { fn: "lerp", args: [0, 10, 0] },
        { fn: "lerp", args: [0, 10, 1] },
        { fn: "lerp", args: [-5, 5, 0.3], approx: true },
        { fn: "smoothstep", args: [0, 1, 0.5], approx: true },
        { fn: "smoothstep", args: [0, 1, 0], approx: true },
        { fn: "smoothstep", args: [0, 1, 1], approx: true },
        { fn: "smoothstep", args: [0, 1, -0.5] },
        { fn: "smoothstep", args: [0, 1, 1.5] },
      ],
    );
  });

  it("string manipulation", async () => {
    const source = `
      export function greet(name: string): string {
        return "Hello, " + name;
      }
      export function exclaim(s: string): string {
        return s + "!";
      }
    `;
    const wasmExports = await compileToWasm(source);
    const jsExports = evaluateAsJs(source);

    for (const args of [["World"], ["Alice"], [""]]) {
      expect(wasmExports.greet(...args)).toBe(jsExports.greet(...args));
      expect(wasmExports.exclaim(...args)).toBe(jsExports.exclaim(...args));
    }
  });

  it("game-loop.ts compiles to WAT and .d.ts", () => {
    const source = readFileSync(
      resolve(__dirname, "game-loop.ts"),
      "utf-8",
    );
    const result = compile(source);
    expect(
      result.success,
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`,
    ).toBe(true);

    // WAT output exists and contains the exported function
    expect(result.wat).toBeTruthy();
    expect(result.wat).toContain("animate");
    expect(result.wat).toContain("(export");

    // .d.ts describes the exported animate function
    expect(result.dts).toContain("export declare function animate(): void;");

    // Import resolver handled all imports (no raw import statements left in WAT)
    expect(result.wat).not.toContain("import *");

    // Has env imports for Math host calls used in game-loop
    expect(result.wat).toContain("Math_exp");
    expect(result.wat).toContain("Math_pow");
  });

  it("game-loop.ts binary instantiates successfully", async () => {
    const source = readFileSync(
      resolve(__dirname, "game-loop.ts"),
      "utf-8",
    );
    const result = compile(source);
    expect(result.success).toBe(true);

    // Build imports using the standard helper (covers env + wasm:js-string)
    const imports = buildImports(result);

    // Auto-stub any remaining import modules/fields that the binary needs
    // by catching instantiation errors and adding stubs via Proxy
    const proxyImports = new Proxy(imports, {
      get(target, module: string) {
        if (module in target) {
          return new Proxy(target[module] as Record<string, unknown>, {
            get(inner, field: string) {
              if (field in inner) return inner[field];
              // Return a no-op function stub for unknown imports
              return () => 0;
            },
          });
        }
        // Return a proxy module that stubs all fields
        return new Proxy({}, { get: () => () => 0 });
      },
    });

    const mod = await WebAssembly.compile(result.binary as BufferSource);
    const instance = await WebAssembly.instantiate(
      mod,
      proxyImports as WebAssembly.Imports,
    );
    expect(instance).toBeTruthy();
    expect(instance.exports.animate).toBeTypeOf("function");
  });

  it("exponentiation operator", async () => {
    await assertEquivalent(
      `
      export function pow(a: number, b: number): number { return a ** b; }
      export function square(x: number): number { return x ** 2; }
      export function sqrtViaPow(x: number): number { return x ** 0.5; }
      export function powAssign(x: number, y: number): number {
        let result: number = x;
        result **= y;
        return result;
      }
      `,
      [
        { fn: "pow", args: [2, 10] },
        { fn: "pow", args: [9, 0.5], approx: true },
        { fn: "pow", args: [3, 0] },
        { fn: "pow", args: [5, 1] },
        { fn: "square", args: [7] },
        { fn: "square", args: [-3] },
        { fn: "sqrtViaPow", args: [9], approx: true },
        { fn: "sqrtViaPow", args: [2], approx: true },
        { fn: "powAssign", args: [2, 3] },
        { fn: "powAssign", args: [5, 2] },
      ],
    );
  });

  it("tagged template literals — basic", async () => {
    await assertEquivalent(
      `
      function tag(strings: string[], a: number, b: number): number {
        return strings.length + a + b;
      }
      export function test1(): number {
        return tag\`hello \${10} world \${20}\`;
      }
      `,
      [
        { fn: "test1", args: [] },
      ],
    );
  });

  it("tagged template literals — no substitutions", async () => {
    await assertEquivalent(
      `
      function tag(strings: string[]): number {
        return strings.length;
      }
      export function test1(): number {
        return tag\`just a string\`;
      }
      `,
      [
        { fn: "test1", args: [] },
      ],
    );
  });

  it("tagged template literals — rest params", async () => {
    await assertEquivalent(
      `
      function tag(strings: string[], ...values: number[]): number {
        return strings.length + values.length;
      }
      export function test1(): number {
        return tag\`a \${1} b \${2} c \${3} d\`;
      }
      export function test2(): number {
        return tag\`no subs\`;
      }
      `,
      [
        { fn: "test1", args: [] },
        { fn: "test2", args: [] },
      ],
    );
  });

  it("tagged template literals — string content access", async () => {
    await assertEquivalent(
      `
      function first(strings: string[]): string {
        return strings[0];
      }
      export function test1(): string {
        return first\`hello world\`;
      }
      `,
      [
        { fn: "test1", args: [] },
      ],
    );
  });

  it("tagged template literals — substitution values", async () => {
    await assertEquivalent(
      `
      function sum(strings: string[], a: number, b: number): number {
        return a + b;
      }
      export function test1(): number {
        const x = 5;
        const y = 10;
        return sum\`\${x} plus \${y}\`;
      }
      `,
      [
        { fn: "test1", args: [] },
      ],
    );
  });

  it("tagged template literals — multiple string parts concatenated", async () => {
    await assertEquivalent(
      `
      function tag(strings: string[], a: number): string {
        return strings[0] + String(a) + strings[1];
      }
      export function test1(): string {
        return tag\`hello \${42} world\`;
      }
      `,
      [
        { fn: "test1", args: [] },
      ],
    );
  });

  it("tagged template literals — return substitution directly", async () => {
    await assertEquivalent(
      `
      function identity(strings: string[], val: number): number {
        return val;
      }
      export function test1(): number {
        return identity\`prefix \${99} suffix\`;
      }
      `,
      [
        { fn: "test1", args: [] },
      ],
    );
  });

  it("tagged template literals — string parts count with expressions", async () => {
    await assertEquivalent(
      `
      function tag(strings: string[], a: number, b: number, c: number): number {
        return strings.length;
      }
      export function test1(): number {
        return tag\`a\${1}b\${2}c\${3}d\`;
      }
      `,
      [
        { fn: "test1", args: [] },
      ],
    );
  });

  it("tagged template literals — excess substitutions dropped", async () => {
    await assertEquivalent(
      `
      function tag(strings: string[]): number {
        return strings.length;
      }
      export function test1(): number {
        return tag\`a\${1}b\${2}c\`;
      }
      `,
      [
        { fn: "test1", args: [] },
      ],
    );
  });

  it("tagged template literals — empty leading string part", async () => {
    await assertEquivalent(
      `
      function first(strings: string[]): string {
        return strings[0];
      }
      export function test1(): string {
        return first\`\${42}trailing\`;
      }
      `,
      [
        { fn: "test1", args: [] },
      ],
    );
  });

  it("typeof comparison — static resolution for number, string, boolean", async () => {
    await assertEquivalent(
      `
      export function typeofNumber(x: number): number {
        return typeof x === "number" ? 1 : 0;
      }
      export function typeofString(x: string): number {
        return typeof x === "string" ? 1 : 0;
      }
      export function typeofBoolean(x: boolean): number {
        return typeof x === "boolean" ? 1 : 0;
      }
      export function typeofMismatch(x: number): number {
        return typeof x === "string" ? 1 : 0;
      }
      export function typeofNeq(x: string): number {
        return typeof x !== "number" ? 1 : 0;
      }
      `,
      [
        { fn: "typeofNumber", args: [42] },
        { fn: "typeofString", args: ["hello"] },
        { fn: "typeofBoolean", args: [true] },
        { fn: "typeofMismatch", args: [42] },
        { fn: "typeofNeq", args: ["hello"] },
      ],
    );
  });
});

describe("Gradual typing: boxed any (fast mode)", () => {
  /**
   * Compile TS source to Wasm in fast mode, instantiate it, and return exports.
   */
  async function compileFast(source: string) {
    const result = compile(source, { fast: true });
    if (!result.success) {
      throw new Error(
        `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`,
      );
    }
    const mod = await WebAssembly.compile(result.binary as BufferSource);
    // Use a proxy to auto-stub any missing imports (e.g. __str_from_mem)
    const baseImports = buildImports(result);
    const proxyImports = new Proxy(baseImports, {
      get(target, module: string) {
        if (module in target) {
          return new Proxy(target[module] as Record<string, unknown>, {
            get(inner, field: string) {
              if (field in inner) return inner[field];
              return () => 0;
            },
          });
        }
        return new Proxy({}, { get: () => () => 0 });
      },
    });
    const instance = await WebAssembly.instantiate(mod, proxyImports as WebAssembly.Imports);
    return instance.exports as Record<string, Function>;
  }

  it("any type: box and unbox i32 number", async () => {
    const exports = await compileFast(`
      export function boxUnboxNum(x: number): number {
        let a: any = x;
        return a as number;
      }
    `);
    expect(exports.boxUnboxNum(42)).toBe(42);
    expect(exports.boxUnboxNum(0)).toBe(0);
    expect(exports.boxUnboxNum(-7)).toBe(-7);
  });

  it("any type: box and unbox boolean via truthiness", async () => {
    const exports = await compileFast(`
      export function boxUnboxBool(x: number): number {
        let a: any = x > 0;
        return a ? 1 : 0;
      }
    `);
    expect(exports.boxUnboxBool(1)).toBe(1);
    expect(exports.boxUnboxBool(0)).toBe(0);
    expect(exports.boxUnboxBool(5)).toBe(1);
  });

  it("any + any: i32 addition", async () => {
    const exports = await compileFast(`
      export function addAny(x: number, y: number): number {
        let a: any = x;
        let b: any = y;
        let c: any = a + b;
        return c as number;
      }
    `);
    expect(exports.addAny(3, 4)).toBe(7);
    expect(exports.addAny(0, 0)).toBe(0);
    expect(exports.addAny(-5, 3)).toBe(-2);
    expect(exports.addAny(100, 200)).toBe(300);
  });

  it("any - any: i32 subtraction", async () => {
    const exports = await compileFast(`
      export function subAny(x: number, y: number): number {
        let a: any = x;
        let b: any = y;
        let c: any = a - b;
        return c as number;
      }
    `);
    expect(exports.subAny(10, 3)).toBe(7);
    expect(exports.subAny(0, 5)).toBe(-5);
  });

  it("any * any: i32 multiplication", async () => {
    const exports = await compileFast(`
      export function mulAny(x: number, y: number): number {
        let a: any = x;
        let b: any = y;
        let c: any = a * b;
        return c as number;
      }
    `);
    expect(exports.mulAny(4, 5)).toBe(20);
    expect(exports.mulAny(-3, 7)).toBe(-21);
  });

  it("any / any: division (always f64 path)", async () => {
    const exports = await compileFast(`
      export function divAny(x: number, y: number): number {
        let a: any = x;
        let b: any = y;
        let c: any = a / b;
        return c as number;
      }
    `);
    expect(exports.divAny(10, 2)).toBe(5);
  });

  it("any % any: modulo", async () => {
    const exports = await compileFast(`
      export function modAny(x: number, y: number): number {
        let a: any = x;
        let b: any = y;
        let c: any = a % b;
        return c as number;
      }
    `);
    expect(exports.modAny(10, 3)).toBe(1);
    expect(exports.modAny(7, 2)).toBe(1);
  });

  it("any == any: equality", async () => {
    const exports = await compileFast(`
      export function eqAny(x: number, y: number): number {
        let a: any = x;
        let b: any = y;
        return (a == b) ? 1 : 0;
      }
    `);
    expect(exports.eqAny(5, 5)).toBe(1);
    expect(exports.eqAny(5, 6)).toBe(0);
    expect(exports.eqAny(0, 0)).toBe(1);
  });

  it("any != any: inequality", async () => {
    const exports = await compileFast(`
      export function neqAny(x: number, y: number): number {
        let a: any = x;
        let b: any = y;
        return (a != b) ? 1 : 0;
      }
    `);
    expect(exports.neqAny(5, 5)).toBe(0);
    expect(exports.neqAny(5, 6)).toBe(1);
  });

  it("any < any: less than comparison", async () => {
    const exports = await compileFast(`
      export function ltAny(x: number, y: number): number {
        let a: any = x;
        let b: any = y;
        return (a < b) ? 1 : 0;
      }
    `);
    expect(exports.ltAny(3, 7)).toBe(1);
    expect(exports.ltAny(7, 3)).toBe(0);
    expect(exports.ltAny(5, 5)).toBe(0);
  });

  it("any > any: greater than comparison", async () => {
    const exports = await compileFast(`
      export function gtAny(x: number, y: number): number {
        let a: any = x;
        let b: any = y;
        return (a > b) ? 1 : 0;
      }
    `);
    expect(exports.gtAny(7, 3)).toBe(1);
    expect(exports.gtAny(3, 7)).toBe(0);
    expect(exports.gtAny(5, 5)).toBe(0);
  });

  it("any <= any: less than or equal", async () => {
    const exports = await compileFast(`
      export function leAny(x: number, y: number): number {
        let a: any = x;
        let b: any = y;
        return (a <= b) ? 1 : 0;
      }
    `);
    expect(exports.leAny(3, 7)).toBe(1);
    expect(exports.leAny(5, 5)).toBe(1);
    expect(exports.leAny(7, 3)).toBe(0);
  });

  it("any >= any: greater than or equal", async () => {
    const exports = await compileFast(`
      export function geAny(x: number, y: number): number {
        let a: any = x;
        let b: any = y;
        return (a >= b) ? 1 : 0;
      }
    `);
    expect(exports.geAny(7, 3)).toBe(1);
    expect(exports.geAny(5, 5)).toBe(1);
    expect(exports.geAny(3, 7)).toBe(0);
  });

  it("typeof any: runtime typeof comparison for numbers", async () => {
    const exports = await compileFast(`
      export function isNumber(x: number): number {
        let a: any = x;
        if (typeof a === "number") return 1;
        return 0;
      }
      export function isNotString(x: number): number {
        let a: any = x;
        if (typeof a !== "string") return 1;
        return 0;
      }
    `);
    expect(exports.isNumber(42)).toBe(1);
    expect(exports.isNumber(0)).toBe(1);
    expect(exports.isNotString(5)).toBe(1);
  });

  it("assignment from typed to any and back", async () => {
    const exports = await compileFast(`
      export function roundTrip(x: number): number {
        let a: any = x;
        let b: number = a as number;
        return b;
      }
      export function roundTripBool(x: number): number {
        let a: any = x > 0;
        let b: number = a ? 1 : 0;
        return b;
      }
    `);
    expect(exports.roundTrip(42)).toBe(42);
    expect(exports.roundTrip(-10)).toBe(-10);
    expect(exports.roundTripBool(5)).toBe(1);
    expect(exports.roundTripBool(0)).toBe(0);
  });

  it("function taking any param and returning any", async () => {
    const exports = await compileFast(`
      function addOne(a: any): any {
        return (a as number) + 1;
      }
      export function testAnyFunc(x: number): number {
        let result: any = addOne(x);
        return result as number;
      }
    `);
    expect(exports.testAnyFunc(10)).toBe(11);
    expect(exports.testAnyFunc(0)).toBe(1);
    expect(exports.testAnyFunc(-5)).toBe(-4);
  });

  it("any negation", async () => {
    const exports = await compileFast(`
      export function negAny(x: number): number {
        let a: any = x;
        let b: any = -a;
        return b as number;
      }
    `);
    expect(exports.negAny(5)).toBe(-5);
    expect(exports.negAny(-3)).toBe(3);
    expect(exports.negAny(0)).toBe(0);
  });
});

describe("Shape inference: array-like objects", () => {
  it("Array.prototype.indexOf.call on array-like object", async () => {
    const src = `
      var obj: any = {};
      obj.length = 3;
      obj[0] = 10;
      obj[1] = 20;
      obj[2] = 30;
      export function test(): number {
        return Array.prototype.indexOf.call(obj, 20);
      }
    `;
    const exports = await compileToWasm(src);
    expect(exports.test()).toBe(1);
  });

  it("Array.prototype.indexOf.call returns -1 for missing element", async () => {
    const src = `
      var obj: any = {};
      obj.length = 3;
      obj[0] = 10;
      obj[1] = 20;
      obj[2] = 30;
      export function test(): number {
        return Array.prototype.indexOf.call(obj, 99);
      }
    `;
    const exports = await compileToWasm(src);
    expect(exports.test()).toBe(-1);
  });

  it("Array.prototype.includes.call on array-like object", async () => {
    const src = `
      var obj: any = {};
      obj.length = 3;
      obj[0] = 10;
      obj[1] = 20;
      obj[2] = 30;
      export function testFound(): boolean {
        return Array.prototype.includes.call(obj, 20);
      }
      export function testMissing(): boolean {
        return Array.prototype.includes.call(obj, 99);
      }
    `;
    const exports = await compileToWasm(src);
    expect(exports.testFound()).toBe(1);
    expect(exports.testMissing()).toBe(0);
  });

  it("Array.prototype.indexOf.call with multiple elements", async () => {
    const src = `
      var obj: any = {};
      obj.length = 5;
      obj[0] = 1;
      obj[1] = 2;
      obj[2] = 3;
      obj[3] = 4;
      obj[4] = 5;
      export function findFirst(): number {
        return Array.prototype.indexOf.call(obj, 1);
      }
      export function findLast(): number {
        return Array.prototype.indexOf.call(obj, 5);
      }
      export function findMiddle(): number {
        return Array.prototype.indexOf.call(obj, 3);
      }
    `;
    const exports = await compileToWasm(src);
    expect(exports.findFirst()).toBe(0);
    expect(exports.findLast()).toBe(4);
    expect(exports.findMiddle()).toBe(2);
  });
});

describe("Private class members", () => {
  it("private field access", async () => {
    const exports = await compileToWasm(`
      class Counter {
        #count: number = 0;
        increment(): void { this.#count = this.#count + 1; }
        getCount(): number { return this.#count; }
      }
      export function test(): number {
        const c = new Counter();
        c.increment();
        c.increment();
        c.increment();
        return c.getCount();
      }
    `);
    expect(exports.test()).toBe(3);
  });

  it("private method call", async () => {
    const exports = await compileToWasm(`
      class Adder {
        #value: number = 0;
        #add(n: number): void { this.#value = this.#value + n; }
        addTwice(n: number): void { this.#add(n); this.#add(n); }
        get(): number { return this.#value; }
      }
      export function test(): number {
        const a = new Adder();
        a.addTwice(5);
        return a.get();
      }
    `);
    expect(exports.test()).toBe(10);
  });

  it("private field assignment in constructor", async () => {
    const exports = await compileToWasm(`
      class Box {
        #val: number;
        constructor(v: number) { this.#val = v; }
        getVal(): number { return this.#val; }
      }
      export function test(): number {
        const b = new Box(42);
        return b.getVal();
      }
    `);
    expect(exports.test()).toBe(42);
  });

  it("private field mutation in method", async () => {
    const exports = await compileToWasm(`
      class Acc {
        #total: number = 0;
        add(n: number): void { this.#total = this.#total + n; }
        reset(): void { this.#total = 0; }
        getTotal(): number { return this.#total; }
      }
      export function test(): number {
        const a = new Acc();
        a.add(10);
        a.add(20);
        a.add(30);
        a.reset();
        a.add(7);
        return a.getTotal();
      }
    `);
    expect(exports.test()).toBe(7);
  });

  it("multiple private fields", async () => {
    const exports = await compileToWasm(`
      class Point {
        #x: number;
        #y: number;
        constructor(x: number, y: number) { this.#x = x; this.#y = y; }
        sum(): number { return this.#x + this.#y; }
      }
      export function test(): number {
        const p = new Point(3, 4);
        return p.sum();
      }
    `);
    expect(exports.test()).toBe(7);
  });
});

describe("Nested class declarations (#150)", () => {
  it("class inside if block", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        if (true) {
          class Foo {
            x: number;
            constructor(x: number) { this.x = x; }
            getX(): number { return this.x; }
          }
          const f = new Foo(42);
          return f.getX();
        }
        return 0;
      }
    `);
    expect(exports.test()).toBe(42);
  });
});

describe("Arguments object", () => {
  it("arguments.length returns parameter count", async () => {
    const exports = await compileToWasm(`
      function countArgs(a: number, b: number, c: number): number {
        return arguments.length;
      }
      export function test(): number {
        return countArgs(10, 20, 30);
      }
    `);
    expect(exports.test()).toBe(3);
  });
});

describe("BigInt", () => {
  it("bigint comparison", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        const a: bigint = 42n;
        const b: bigint = 42n;
        if (a === b) return 1;
        return 0;
      }
    `);
    expect(exports.test()).toBe(1);
  });
});

describe("Logical operators returning values", () => {
  it("0 || 42 returns 42", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return 0 || 42;
      }
    `);
    expect(exports.test()).toBe(42);
  });

  it("5 || 42 returns 5", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return 5 || 42;
      }
    `);
    expect(exports.test()).toBe(5);
  });

  it("1 && 42 returns 42", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return 1 && 42;
      }
    `);
    expect(exports.test()).toBe(42);
  });

  it("0 && 42 returns 0", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return 0 && 42;
      }
    `);
    expect(exports.test()).toBe(0);
  });

  it("variable || default value", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let x: number = 0;
        let result = x || 99;
        return result;
      }
    `);
    expect(exports.test()).toBe(99);
  });

  it("truthy variable || default value returns variable", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let x: number = 7;
        let result = x || 99;
        return result;
      }
    `);
    expect(exports.test()).toBe(7);
  });

  it("chained logical or", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return 0 || 0 || 3;
      }
    `);
    expect(exports.test()).toBe(3);
  });

  it("chained logical and", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return 1 && 2 && 3;
      }
    `);
    expect(exports.test()).toBe(3);
  });
});
describe("Switch fallthrough", () => {
  it("fallthrough: case 1 falls through to case 2", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let x = 0;
        switch (1) {
          case 1: x += 10;
          case 2: x += 20; break;
        }
        return x;
      }
    `);
    expect(exports.test()).toBe(30);
  });
  it("no fallthrough with break", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let x = 0;
        switch (1) {
          case 1: x = 10; break;
          case 2: x = 20; break;
        }
        return x;
      }
    `);
    expect(exports.test()).toBe(10);
  });
  it("multiple cases sharing body", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let x = 0;
        switch (2) {
          case 1:
          case 2: x = 42; break;
        }
        return x;
      }
    `);
    expect(exports.test()).toBe(42);
  });
  it("default fallthrough", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let x = 0;
        switch (99) {
          case 1: x += 10; break;
          default: x += 5;
          case 2: x += 20; break;
        }
        return x;
      }
    `);
    expect(exports.test()).toBe(25);
  });
});
  it("string concatenation with variables", async () => {
    await assertEquivalent(
      `
      export function greetFull(first: string, last: string): string {
        return first + " " + last;
      }
      `,
      [
        { fn: "greetFull", args: ["Jane", "Doe"] },
        { fn: "greetFull", args: ["", "Solo"] },
        { fn: "greetFull", args: ["One", ""] },
      ],
    );
  });
  it("string += compound assignment", async () => {
    await assertEquivalent(
      `
      export function buildGreeting(name: string): string {
        let result: string = "Hello";
        result += ", ";
        result += name;
        result += "!";
        return result;
      }
      `,
      [
        { fn: "buildGreeting", args: ["World"] },
        { fn: "buildGreeting", args: ["Alice"] },
      ],
    );
  });
  it("multi-variable string concat chain", async () => {
    await assertEquivalent(
      `
      export function join3(a: string, b: string, c: string): string {
        return a + b + c;
      }
      `,
      [
        { fn: "join3", args: ["x", "y", "z"] },
        { fn: "join3", args: ["hello", " ", "world"] },
        { fn: "join3", args: ["", "", ""] },
      ],
    );
  });
  it("ternary with non-boolean return values", async () => {
    await assertEquivalent(
      `
      export function pickNum(flag: boolean): number {
        return flag ? 10 : 20;
      }
      export function pickNested(x: number): number {
        return x > 0 ? 100 : x < 0 ? -100 : 0;
      }
      export function ternaryMath(a: number, b: number): number {
        return a > b ? a - b : b - a;
      }
      `,
      [
        { fn: "pickNum", args: [true] },
        { fn: "pickNum", args: [false] },
        { fn: "pickNested", args: [5] },
        { fn: "pickNested", args: [-3] },
        { fn: "pickNested", args: [0] },
        { fn: "ternaryMath", args: [10, 3] },
        { fn: "ternaryMath", args: [3, 10] },
      ],
    );
  });
describe("Loose equality (== / !=)", () => {
  it("number == boolean coercion", async () => {
    await assertEquivalent(
      `
      export function zeroEqFalse(): number { return (0 == false) ? 1 : 0; }
      export function oneEqTrue(): number { return (1 == true) ? 1 : 0; }
      export function twoNeqTrue(): number { return (2 != true) ? 1 : 0; }
      `,
      [
        { fn: "zeroEqFalse", args: [] },
        { fn: "oneEqTrue", args: [] },
        { fn: "twoNeqTrue", args: [] },
      ],
    );
  });
  it("boolean == number coercion", async () => {
    await assertEquivalent(
      `
      export function falseEqZero(): number { return (false == 0) ? 1 : 0; }
      export function trueEqOne(): number { return (true == 1) ? 1 : 0; }
      export function trueNeqTwo(): number { return (true != 2) ? 1 : 0; }
      `,
      [
        { fn: "falseEqZero", args: [] },
        { fn: "trueEqOne", args: [] },
        { fn: "trueNeqTwo", args: [] },
      ],
    );
  });
  it("null == undefined coercion", async () => {
    const exports = await compileToWasm(`
      export function nullEqUndef(): number { return (null == undefined) ? 1 : 0; }
      export function undefEqNull(): number { return (undefined == null) ? 1 : 0; }
      export function nullNeqUndef(): number { return (null != undefined) ? 1 : 0; }
    `);
    expect(exports.nullEqUndef()).toBe(1);
    expect(exports.undefEqNull()).toBe(1);
    expect(exports.nullNeqUndef()).toBe(0);
  });
  it("same-type loose equality delegates to strict", async () => {
    await assertEquivalent(
      `
      export function numEq(): number { return (5 == 5) ? 1 : 0; }
      export function numNeq(): number { return (5 != 3) ? 1 : 0; }
      export function boolEq(): number { return (true == true) ? 1 : 0; }
      `,
      [
        { fn: "numEq", args: [] },
        { fn: "numNeq", args: [] },
        { fn: "boolEq", args: [] },
      ],
    );
  });
});


describe("typeof comparison", () => {
  it("typeof number === 'number'", async () => {
    const exports = await compileToWasm(`
      export function test(x: number): number {
        if (typeof x === "number") return 1;
        return 0;
      }
    `);
    expect(exports.test(42)).toBe(1);
  });

  it("typeof string === 'string'", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        const s: string = "hello";
        if (typeof s === "string") return 1;
        return 0;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("typeof boolean === 'boolean'", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        const b: boolean = true;
        if (typeof b === "boolean") return 1;
        return 0;
      }
    `);
    expect(exports.test()).toBe(1);
  });
});

describe("object literal getters/setters", () => {
  it("getter returns computed value", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        const obj = { _val: 10, get x() { return this._val * 2; } };
        return obj.x;
      }
    `);
    expect(exports.test()).toBe(20);
  });

  it("setter stores value", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        const obj = {
          _val: 0,
          get x() { return this._val; },
          set x(v: number) { this._val = v; }
        };
        obj.x = 42;
        return obj.x;
      }
    `);
    expect(exports.test()).toBe(42);
  });

  it("object literal method", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        const obj = {
          val: 5,
          double() { return this.val * 2; }
        };
        return obj.double();
      }
    `);
    expect(exports.test()).toBe(10);
  });

  // ── valueOf/toString coercion on operators (#138/#139) ──

  it("valueOf coercion on comparison operators (#138)", async () => {
    // First test: simple valueOf via class method
    const exports = await compileToWasm(`
      class Box {
        val: number;
        constructor(v: number) { this.val = v; }
        valueOf(): number { return this.val; }
      }

      export function gtTrue(): number { const b = new Box(42); return b > 10 ? 1 : 0; }
      export function gtFalse(): number { const b = new Box(5); return b > 10 ? 1 : 0; }
      export function ltTrue(): number { const b = new Box(3); return b < 10 ? 1 : 0; }
      export function gteTrue(): number { const b = new Box(10); return b >= 10 ? 1 : 0; }
      export function lteTrue(): number { const b = new Box(10); return b <= 10 ? 1 : 0; }
    `);
    expect(exports.gtTrue()).toBe(1);
    expect(exports.gtFalse()).toBe(0);
    expect(exports.ltTrue()).toBe(1);
    expect(exports.gteTrue()).toBe(1);
    expect(exports.lteTrue()).toBe(1);
  });

  it("valueOf coercion on arithmetic operators (#139)", async () => {
    const exports = await compileToWasm(`
      class Num {
        val: number;
        constructor(v: number) { this.val = v; }
        valueOf(): number { return this.val; }
      }

      export function add(): number { const n = new Num(5); return n + 3; }
      export function sub(): number { const n = new Num(10); return n - 3; }
      export function mul(): number { const n = new Num(4); return n * 5; }
      export function div(): number { const n = new Num(20); return n / 4; }
      export function mod(): number { const n = new Num(17); return n % 5; }
      export function neg(): number { const n = new Num(7); return -n; }
      export function pos(): number { const n = new Num(42); return +n; }
    `);
    expect(exports.add()).toBe(8);
    expect(exports.sub()).toBe(7);
    expect(exports.mul()).toBe(20);
    expect(exports.div()).toBe(5);
    expect(exports.mod()).toBe(2);
    expect(exports.neg()).toBe(-7);
    expect(exports.pos()).toBe(42);
  });

  it("valueOf coercion on loose equality (#138)", async () => {
    const exports = await compileToWasm(`
      class Val {
        val: number;
        constructor(v: number) { this.val = v; }
        valueOf(): number { return this.val; }
      }

      export function eqTrue(): number { const v = new Val(42); return v == 42 ? 1 : 0; }
      export function eqFalse(): number { const v = new Val(42); return v == 99 ? 1 : 0; }
      export function neqTrue(): number { const v = new Val(42); return v != 99 ? 1 : 0; }
      export function neqFalse(): number { const v = new Val(42); return v != 42 ? 1 : 0; }
    `);
    expect(exports.eqTrue()).toBe(1);
    expect(exports.eqFalse()).toBe(0);
    expect(exports.neqTrue()).toBe(1);
    expect(exports.neqFalse()).toBe(0);
  });
});

describe("IIFE and call expression edge cases", () => {
  it("IIFE with no args", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        var result: number = 0;
        (function() {
          result = 42;
        })();
        return result;
      }
    `);
    expect(exports.test()).toBe(42);
  });

  it("IIFE with args and return value", async () => {
    await assertEquivalent(
      `
      export function test(a: number, b: number): number {
        return (function(x: number, y: number): number {
          return x + y;
        })(a, b);
      }
      `,
      [
        { fn: "test", args: [10, 20] },
        { fn: "test", args: [-5, 5] },
        { fn: "test", args: [0, 0] },
      ],
    );
  });

  it("IIFE captures outer variable (mutable)", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        var counter: number = 0;
        (function() {
          counter = counter + 10;
        })();
        return counter;
      }
    `);
    expect(exports.test()).toBe(10);
  });

  it("extra arguments are evaluated for side effects", async () => {
    await assertEquivalent(
      `
      var sideEffect: number = 0;
      function f(): number { return 1; }
      function g(): number { sideEffect = 99; return 5; }
      export function test(): number {
        f(g());
        return sideEffect;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("extra arguments to zero-param function", async () => {
    await assertEquivalent(
      `
      function f(): number { return 42; }
      export function test(): number {
        return f(1, 2, 3);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });


  // === Tests from #218-219 ===


  // --- Issue #218: Boolean(x = 0) should return false ---
  it("Boolean with assignment expression argument", async () => {
    await assertEquivalent(
      `
      export function test1(): number {
        var x: number = 5;
        return Boolean(x = 0) ? 1 : 0;
      }
      export function test2(): number {
        var x: number = 5;
        return Boolean(x = 1) ? 1 : 0;
      }
      export function test3(): number {
        var x: number = 0;
        return Boolean(x = 42) ? 1 : 0;
      }
      `,
      [
        { fn: "test1", args: [] },
        { fn: "test2", args: [] },
        { fn: "test3", args: [] },
      ],
    );
  });

  it("Boolean with empty string argument", async () => {
    await assertEquivalent(
      `
      export function test1(): number {
        return Boolean("") ? 1 : 0;
      }
      export function test2(): number {
        return Boolean("hello") ? 1 : 0;
      }
      `,
      [
        { fn: "test1", args: [] },
        { fn: "test2", args: [] },
      ],
    );
  });

  // --- Issue #219: void expression edge cases ---
  it("void expression returns undefined-like", async () => {
    await assertEquivalent(
      `
      export function test1(): number {
        var x: number = 1;
        void x;
        return x;
      }
      export function test2(): number {
        var x: number = 0;
        void (x = 5);
        return x;
      }
      `,
      [
        { fn: "test1", args: [] },
        { fn: "test2", args: [] },
      ],
    );
  });

  // --- Issue #219: switch statement with various cases ---
  it("switch with multiple case values", async () => {
    await assertEquivalent(
      `
      export function test(x: number): number {
        var result: number = 0;
        switch (x) {
          case 0: result = 10; break;
          case 1: result = 20; break;
          case 2: result = 30; break;
          default: result = -1;
        }
        return result;
      }
      `,
      [
        { fn: "test", args: [0] },
        { fn: "test", args: [1] },
        { fn: "test", args: [2] },
        { fn: "test", args: [3] },
      ],
    );
  });

  // --- Issue #219: return statement edge cases ---
  it("return from nested if in function", async () => {
    await assertEquivalent(
      `
      function myfunc(x: number): number {
        if (x > 0) {
          return x * 2;
        }
        return -1;
      }
      export function test(): number {
        return myfunc(5) + myfunc(-1);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  // --- Issue #219: logical-and returning values ---
  it("logical-and with numeric operands", async () => {
    await assertEquivalent(
      `
      export function test1(): number { return (1 && 2) as number; }
      export function test2(): number { return (0 && 2) as number; }
      export function test3(): number { return (1 && 0) as number; }
      `,
      [
        { fn: "test1", args: [] },
        { fn: "test2", args: [] },
        { fn: "test3", args: [] },
      ],
    );
  });

  // --- Issue #219: logical-or returning values ---
  it("logical-or with numeric operands", async () => {
    await assertEquivalent(
      `
      export function test1(): number { return (1 || 2) as number; }
      export function test2(): number { return (0 || 2) as number; }
      export function test3(): number { return (0 || 0) as number; }
      `,
      [
        { fn: "test1", args: [] },
        { fn: "test2", args: [] },
        { fn: "test3", args: [] },
      ],
    );
  });

  // --- Issue #218: Boolean with NaN ---
  it("Boolean with NaN returns false", async () => {
    await assertEquivalent(
      `
      export function test1(): number { return Boolean(NaN) ? 1 : 0; }
      export function test2(): number { return Boolean(0) ? 1 : 0; }
      export function test3(): number { return Boolean(-0) ? 1 : 0; }
      export function test4(): number { return Boolean(1) ? 1 : 0; }
      export function test5(): number { return Boolean(-1) ? 1 : 0; }
      `,
      [
        { fn: "test1", args: [] },
        { fn: "test2", args: [] },
        { fn: "test3", args: [] },
        { fn: "test4", args: [] },
        { fn: "test5", args: [] },
      ],
    );
  });

  // --- Issue #218: Boolean with assignment side effects ---
  it("Boolean assignment side effects preserved", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var x: number = 10;
        var b: boolean = Boolean(x = 0);
        // x should be 0 (side effect) and b should be false
        return x + (b ? 100 : 0);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  // === Tests from #210 ===


  it("for-of with object destructuring", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let sum = 0;
        const arr: {x: number, y: number}[] = [{x: 1, y: 2}, {x: 3, y: 4}];
        for (const {x, y} of arr) {
          sum = sum + x + y;
        }
        return sum;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("for-of with object destructuring and default values", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let sum = 0;
        const arr: {x: number}[] = [{x: 10}, {x: 20}];
        for (const {x} of arr) {
          sum = sum + x;
        }
        return sum;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("for-of destructuring with var", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let result = 0;
        const items: {a: number, b: number}[] = [{a: 5, b: 3}, {a: 7, b: 2}];
        for (var {a, b} of items) {
          result = result + a * b;
        }
        return result;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  // === Issue #246: for-of object destructuring with missing properties ===

  it("for-of destructuring missing property with default value", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let result = 0;
        const arr: {y: number}[] = [{y: 2}];
        for (const {x = 1} of arr) {
          result = x;
        }
        return result;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("for-of destructuring some fields present some missing", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let result = 0;
        const arr: {a: number}[] = [{a: 10}];
        for (const {a, b = 5} of arr) {
          result = a + b;
        }
        return result;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("for-of destructuring field exists with default, value takes precedence", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let result = 0;
        const arr: {x: number}[] = [{x: 42}];
        for (const {x = 99} of arr) {
          result = x;
        }
        return result;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  // === Tests from #211 ===


  it("void function returns undefined (=== undefined)", async () => {
    await assertEquivalent(
      `
      function voidFunc(): void {
      }
      export function test(): number {
        // void function call compared to undefined should be equal
        if (voidFunc() === undefined) return 1;
        return 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("void function with bare return returns undefined", async () => {
    await assertEquivalent(
      `
      let x: number = 0;
      function voidFunc(): void {
        x = 1;
        return;
      }
      export function test(): number {
        if (voidFunc() !== undefined) return 0;
        if (x !== 1) return 0;
        return 1;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("function.length property (formal parameter count)", async () => {
    await assertEquivalent(
      `
      function zero(): void {}
      function one(a: number): number { return a; }
      function three(a: number, b: number, c: number): number { return a + b + c; }
      export function test(): number {
        return zero.length * 100 + one.length * 10 + three.length;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("pass-by-value semantics for primitives", async () => {
    await assertEquivalent(
      `
      function modify(arg1: number): void {
        arg1++;
      }
      export function test(): number {
        let x: number = 1;
        modify(x);
        return x;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  // === Tests from #212 ===

  it("tagged template literals — same call site returns same object across calls", async () => {
    await assertEquivalent(
      `
      function eq(a: string[], b: string[]): number {
        return a === b ? 1 : 0;
      }
      function tag(strings: string[]): string[] {
        return strings;
      }
      function getTemplate(): string[] {
        return tag\`hello\`;
      }
      export function test1(): number {
        const first = getTemplate();
        const second = getTemplate();
        return eq(first, second);
      }
      `,
      [
        { fn: "test1", args: [] },
      ],
    );
  });

  it("tagged template literals — different sites produce different objects", async () => {
    await assertEquivalent(
      `
      function eq(a: string[], b: string[]): number {
        return a === b ? 1 : 0;
      }
      function tag(strings: string[]): string[] {
        return strings;
      }
      export function test1(): number {
        const first = tag\`aaa\`;
        const second = tag\`bbb\`;
        return eq(first, second);
      }
      `,
      [
        { fn: "test1", args: [] },
      ],
    );
  });

  it("tagged template literals — same site caches even with different expression values", async () => {
    await assertEquivalent(
      `
      function eq(a: string[], b: string[]): number {
        return a === b ? 1 : 0;
      }
      function tag(strings: string[], ...subs: number[]): string[] {
        return strings;
      }
      function getTemplate(x: number): string[] {
        return tag\`head\${x}tail\`;
      }
      export function test1(): number {
        const first = getTemplate(1);
        const second = getTemplate(2);
        return eq(first, second);
      }
      `,
      [
        { fn: "test1", args: [] },
      ],
    );
  });


  // === Tests from #213 ===


describe("New expression with spread arguments (#213)", () => {
  it("spread-sngl-empty: new function(){}(...[])", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        var callCount = 0;
        new function() {
          callCount = callCount + 1;
        }(...[]);
        return callCount;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("spread-sngl-literal: new function(){}(...[3,4,5]) with arguments", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        var result = 0;
        new function() {
          result = arguments.length;
        }(...[3, 4, 5]);
        return result;
      }
    `);
    expect(exports.test()).toBe(3);
  });

  it("spread-sngl-literal: typed params receive spread values", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        var result = 0;
        new function(a: number, b: number, c: number) {
          result = a + b + c;
        }(...[3, 4, 5]);
        return result;
      }
    `);
    expect(exports.test()).toBe(12);
  });

  it("spread-mult-empty: new function(){}(1, 2, 3, ...[])", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        var result = 0;
        new function() {
          result = arguments.length;
        }(1, 2, 3, ...[]);
        return result;
      }
    `);
    expect(exports.test()).toBe(3);
  });

  it("spread-mult-literal: new function(){}(5, ...[6, 7, 8], 9)", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        var result = 0;
        new function() {
          result = arguments.length;
        }(5, ...[6, 7, 8], 9);
        return result;
      }
    `);
    expect(exports.test()).toBe(5);
  });

  it("spread-mult-literal: typed params receive correct values", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        var result = 0;
        new function(a: number, b: number, c: number, d: number, e: number) {
          result = a + b + c + d + e;
        }(5, ...[6, 7, 8], 9);
        return result;
      }
    `);
    expect(exports.test()).toBe(35);
  });

  it("new expression at module top level with spread", async () => {
    const exports = await compileToWasm(`
      var callCount = 0;
      new function() {
        callCount = callCount + 1;
      }(...[]);
      export function test(): number {
        return callCount;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("module-level new with spread and typed params", async () => {
    const exports = await compileToWasm(`
      var result = 0;
      new function(a: number, b: number, c: number) {
        result = a + b + c;
      }(...[10, 20, 30]);
      export function test(): number {
        return result;
      }
    `);
    expect(exports.test()).toBe(60);
  });
});

  // === Tests from #207-208 ===


  // -- Issue #208: computed property names with expressions --

  it("computed property name with addition expression", async () => {
    await assertEquivalent(
      `
      const key = "he" + "llo";
      const obj: { hello: number } = { [key]: 42 };
      export function test(): number {
        return obj.hello;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("computed property name with ternary expression", async () => {
    await assertEquivalent(
      `
      const flag = 1;
      const obj: { yes: number } = { [flag ? "yes" : "no"]: 10 };
      export function test(): number {
        return obj.yes;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("computed property name with template literal", async () => {
    await assertEquivalent(
      `
      const part = "val";
      const obj: { myval: number } = { [\`my\${part}\`]: 77 };
      export function test(): number {
        return obj.myval;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("computed property name with numeric expression", async () => {
    await assertEquivalent(
      `
      const arr: number[] = [0, 0, 0];
      arr[1 + 1] = 99;
      export function test(): number {
        return arr[2];
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("computed property name with const variable expression", async () => {
    await assertEquivalent(
      `
      const a = "hel";
      const b = "lo";
      const key = a + b;
      const obj: { hello: number } = { [key]: 55 };
      export function test(): number {
        return obj.hello;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  // === Tests from #209-217 ===


  // Issue #209: for-loop with continue and string concatenation of numbers
  it("for-loop continue with string concat", async () => {
    await assertEquivalent(
      `
      export function test(): string {
        var __str = "";
        for (var index = 0; index < 10; index += 1) {
          if (index < 5) continue;
          __str += index;
        }
        return __str;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("for-loop continue with string concat (all iterations)", async () => {
    await assertEquivalent(
      `
      export function test(): string {
        var s = "";
        for (var i = 0; i < 5; i++) {
          if (i === 2) continue;
          s += i;
        }
        return s;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  // Issue #209: for-loop with string literal as condition
  it("for-loop with string literal condition", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var accessed: number = 0;
        for (var i = 0; "hello"; ) {
          accessed = 1;
          break;
        }
        return accessed;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  // Issue #209: for-loop with object as condition
  it("for-loop with object condition", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var accessed: number = 0;
        var obj = { value: false };
        for (var i = 0; obj; ) {
          accessed = 1;
          break;
        }
        return accessed;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  // Issue #209: for-loop with number literal condition (non-boolean)
  it("for-loop with numeric literal condition", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var accessed: number = 0;
        for (var i = 0; 2; ) {
          accessed = 1;
          break;
        }
        return accessed;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  // Issue #217: while/do-while with string truthiness in loop condition
  it("while loop with string condition", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var s: string = "hello";
        var count: number = 0;
        while (s) {
          count++;
          if (count >= 3) s = "";
        }
        return count;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("do-while loop with string concatenation condition", async () => {
    await assertEquivalent(
      `
      export function test(): string {
        var result: string = "";
        var i: number = 0;
        do {
          result += i;
          i++;
        } while (i < 3);
        return result;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  // Issue #217: while loop with string variable condition
  it("while loop with string variable truthiness", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var s: string = "abc";
        var n: number = 0;
        while (s) {
          n++;
          s = "";
        }
        return n;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  // Issue #217: do-while with string condition
  it("do-while with string truthiness condition", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var s: string = "x";
        var n: number = 0;
        do {
          n++;
          if (n >= 2) s = "";
        } while (s);
        return n;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  // Issue #209: for-loop with string condition (test262 pattern - module level)
  it("for-loop with string condition - module level vars", async () => {
    const exports = await compileToWasm(`
let __fail: number = 0;

function assert_true(value: number): void {
  if (!value) {
    __fail = 1;
  }
}

export function test(): number {
  var accessed: number = 0;
  for (var i = 0; "undefined"; ) {
    accessed = 1;
    break;
  }
  assert_true(accessed);
  if (__fail) { return 0; }
  return 1;
}
    `);
    expect(exports.test!()).toBe(1);
  });

  // Issue #209: for-loop with object condition (test262 pattern)
  it("for-loop with object condition - assert pattern", async () => {
    const exports = await compileToWasm(`
let __fail: number = 0;

function assert_true(value: number): void {
  if (!value) {
    __fail = 1;
  }
}

export function test(): number {
  var accessed = false;
  var obj = { value: false };
  for (var i = 0; obj; ) {
    accessed = true;
    break;
  }
  if (!accessed) { __fail = 1; }
  if (__fail) { return 0; }
  return 1;
}
    `);
    expect(exports.test!()).toBe(1);
  });

  // Issue #209: for-loop with assert_true(boolean, string) - extra arg pattern
  it("for-loop assert_true with extra string arg", async () => {
    const exports = await compileToWasm(`
let __fail: number = 0;

function assert_true(value: number): void {
  if (!value) {
    __fail = 1;
  }
}

export function test(): number {
  var accessed = false;
  var obj = { value: false };
  for (var i = 0; obj; ) {
    accessed = true;
    break;
  }
  assert_true(accessed, 'accessed !== true');
  if (__fail) { return 0; }
  return 1;
}
    `);
    expect(exports.test!()).toBe(1);
  });

  // Exact test262 wrapper pattern for 12.6.3_2-3-a-ii-19 (string condition "undefined")
  it("test262 for-loop string condition pattern", async () => {
    const exports = await compileToWasm(`
let __fail: number = 0;

function isSameValue(a: number, b: number): number {
  if (a === b) { return 1; }
  if (a !== a && b !== b) { return 1; }
  return 0;
}

function assert_sameValue(actual: number, expected: number): void {
  if (!isSameValue(actual, expected)) {
    __fail = 1;
  }
}

function assert_notSameValue(actual: number, expected: number): void {
  if (isSameValue(actual, expected)) {
    __fail = 1;
  }
}

function assert_true(value: number): void {
  if (!value) {
    __fail = 1;
  }
}

export function test(): number {
  var accessed = false;
  for (var i = 0; "undefined"; ) {
    accessed = true;
    break;
  }
  assert_true(accessed, 'accessed !== true');
  if (__fail) { return 0; }
  return 1;
}
    `);
    expect(exports.test!()).toBe(1);
  });

  // Issue #209: untyped var string concat (test262 pattern: var __str; __str=""; __str+=index)
  it("untyped var string concat with continue", async () => {
    await assertEquivalent(
      `
      export function test(): string {
        var __str: any, index: any;
        __str = "";
        for (index = 0; index < 10; index += 1) {
          if (index < 5) continue;
          __str += index;
        }
        return __str;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  // Labeled block break (non-loop labeled statement)
  it("labeled block break exits block", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var i: number = 0;
        outer: {
          while (true) {
            i++;
            if (i === 10) {
              break outer;
            }
          }
          i = 999; // should not be reached
        }
        return i;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  // Labeled block break with do-while
  it("labeled block break from do-while", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var i: number = 0;
        outer: {
          do {
            i++;
            if (i === 5) break outer;
          } while (true);
          i = 999;
        }
        return i;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  // === Tests from #214-215-216 ===


// Issue #214: String relational operators
describe("String relational operators (#214)", () => {
  it("string < string", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const a: string = "apple";
        const b: string = "banana";
        return (a < b) ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("string > string", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const a: string = "banana";
        const b: string = "apple";
        return (a > b) ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("string <= string (equal)", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const a: string = "hello";
        const b: string = "hello";
        return (a <= b) ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("string >= string (greater)", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const a: string = "xyz";
        const b: string = "abc";
        return (a >= b) ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("string comparison with prefix", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const a: string = "abc";
        const b: string = "abcd";
        return (a < b) ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("string comparison - not less than", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const a: string = "banana";
        const b: string = "apple";
        return (a < b) ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});

// Issue #215: Unary plus coercion
describe("Unary plus coercion (#215)", () => {
  it('+\"\" should be 0', async () => {
    await assertEquivalent(
      `
      export function test(): number {
        return +"";
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("+true should be 1", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        return +true;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("+false should be 0", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        return +false;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it('+\"123\" should be 123', async () => {
    await assertEquivalent(
      `
      export function test(): number {
        return +"123";
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});

// Issue #216: Modulus with special values
describe("Modulus with special values (#216)", () => {
  it("x % Infinity should be x (finite x)", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        return 5 % Infinity;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("x % -Infinity should be x (finite x)", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        return 5 % -Infinity;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("Infinity % x should be NaN", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        return Infinity % 3;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("x % 0 should be NaN", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        return 5 % 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("basic modulo still works", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        return 7 % 3;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("negative modulo", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        return -7 % 3;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});

  // === Tests from #221 ===


  it("comma operator indirect call: (0, fn)()", async () => {
    await assertEquivalent(
      `
      function add(a: number, b: number): number { return a + b; }
      export function test(): number {
        return (0, add)(3, 4);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("comma operator indirect call with side effects", async () => {
    await assertEquivalent(
      `
      var counter: number = 0;
      function inc(): number { counter = counter + 1; return counter; }
      function double(x: number): number { return x * 2; }
      export function test(): number {
        const result = (inc(), double)(5);
        return result + counter;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("fn.call() with thisArg dropped", async () => {
    await assertEquivalent(
      `
      function add(a: number, b: number): number { return a + b; }
      export function test(): number {
        return add.call(null, 10, 20);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("fn.call() with no extra args", async () => {
    await assertEquivalent(
      `
      function getFortyTwo(): number { return 42; }
      export function test(): number {
        return getFortyTwo.call(null);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("fn.call() with undefined thisArg", async () => {
    await assertEquivalent(
      `
      function multiply(a: number, b: number): number { return a * b; }
      export function test(): number {
        return multiply.call(undefined, 6, 7);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("chained method call on returned value", async () => {
    await assertEquivalent(
      `
      class Builder {
        value: number;
        constructor(v: number) { this.value = v; }
        add(n: number): Builder { return new Builder(this.value + n); }
        result(): number { return this.value; }
      }
      function makeBuilder(): Builder { return new Builder(0); }
      export function test(): number {
        return makeBuilder().add(10).add(20).result();
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  // === Tests from #222 ===


  it("object destructuring var hoisting", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var obj = { x: 10, y: 20 };
        var { x, y } = obj;
        return x + y;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("array destructuring var hoisting", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var arr: number[] = [3, 7];
        var [a, b] = arr;
        return a + b;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("var in nested block is accessible after block", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var result = 0;
        if (true) {
          var x = 42;
          result = x;
        }
        return result;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("var in for-loop body is hoisted", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        for (var i = 0; i < 3; i++) {
          var x = i * 10;
        }
        return x;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  // === Tests from #223-224 ===


  // --- Issue #223: Computed property names in class declarations ---

  it("class with string literal computed property name", async () => {
    await assertEquivalent(
      `
      class Counter {
        ["count"]: number;
        constructor() {
          this.count = 0;
        }
        ["increment"](): number {
          this.count = this.count + 1;
          return this.count;
        }
      }
      export function test(): number {
        const c = new Counter();
        c.increment();
        c.increment();
        return c.count;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("class with numeric literal computed property name", async () => {
    const exports = await compileToWasm(`
      class Data {
        ["value"]: number;
        constructor(v: number) {
          this.value = v;
        }
        ["double"](): number {
          return this.value * 2;
        }
      }
      export function test(n: number): number {
        const d = new Data(n);
        return d.double();
      }
    `);
    expect(exports.test(21)).toBe(42);
    expect(exports.test(5)).toBe(10);
  });

  // --- Issue #224: Prefix/postfix increment/decrement on member expressions ---

  it("prefix increment on object property", async () => {
    await assertEquivalent(
      `
      class Box {
        value: number;
        constructor(v: number) {
          this.value = v;
        }
      }
      export function test(): number {
        const b = new Box(10);
        const result = ++b.value;
        return result;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("prefix decrement on object property", async () => {
    await assertEquivalent(
      `
      class Box {
        value: number;
        constructor(v: number) {
          this.value = v;
        }
      }
      export function test(): number {
        const b = new Box(10);
        --b.value;
        return b.value;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("postfix increment on object property", async () => {
    await assertEquivalent(
      `
      class Box {
        value: number;
        constructor(v: number) {
          this.value = v;
        }
      }
      export function test(): number {
        const b = new Box(10);
        const old = b.value++;
        return old;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("postfix increment stores new value", async () => {
    await assertEquivalent(
      `
      class Box {
        value: number;
        constructor(v: number) {
          this.value = v;
        }
      }
      export function test(): number {
        const b = new Box(10);
        b.value++;
        return b.value;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("postfix decrement on object property", async () => {
    await assertEquivalent(
      `
      class Box {
        value: number;
        constructor(v: number) {
          this.value = v;
        }
      }
      export function test(): number {
        const b = new Box(10);
        const old = b.value--;
        return old;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("multiple increments on object property", async () => {
    await assertEquivalent(
      `
      class Counter {
        count: number;
        constructor() {
          this.count = 0;
        }
      }
      export function test(): number {
        const c = new Counter();
        ++c.count;
        ++c.count;
        c.count++;
        return c.count;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("array element increment", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const arr: number[] = [10, 20, 30];
        arr[1]++;
        return arr[1];
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("prefix increment on array element", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const arr: number[] = [10, 20, 30];
        const result = ++arr[0];
        return result;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});

describe("Scope and error handling (#180, #196, #197)", () => {
  it("var re-declaration with different types (#180)", async () => {
    await assertEquivalent(
      `
      var x: number = 1;
      var y: number = x + 10;
      export function test(): number {
        return y;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("function declaration inside if-branch (#197)", async () => {
    await assertEquivalent(
      `
      function makeF(): number {
        if (true) {
          function inner(): number { return 42; }
          return inner();
        }
        return 0;
      }
      export function test(): number {
        return makeF();
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("function declaration in else-branch (#197)", async () => {
    await assertEquivalent(
      `
      function makeF(cond: boolean): number {
        if (cond) {
          return 1;
        } else {
          function inner(): number { return 99; }
          return inner();
        }
      }
      export function test(): number {
        return makeF(false);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("function declaration inside try block (#196)", async () => {
    await assertEquivalent(
      `
      function wrapper(): number {
        try {
          function helper(): number { return 7; }
          return helper();
        } catch (e) {
          return -1;
        }
      }
      export function test(): number {
        return wrapper();
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("try-catch with catch variable (#196)", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var result: number = 0;
        try {
          result = 1;
        } catch (e) {
          result = -1;
        }
        return result;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});

describe("boolean relational comparison", () => {
  it("true > false", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        return (true > false) ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("false < true", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        return (false < true) ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("true >= true", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        return (true >= true) ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("false <= false", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        return (false <= false) ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});

// ── Issue #185: Unary plus on non-numeric types ──
describe("unary plus coercion (#185)", () => {
  it('+\"\" produces 0', async () => {
    await assertEquivalent(
      `export function test(): number { return +""; }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("+null produces 0", async () => {
    await assertEquivalent(
      `export function test(): number { return +null; }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("+undefined produces NaN", async () => {
    await assertEquivalent(
      `export function test(): number { return +undefined; }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("+true produces 1", async () => {
    await assertEquivalent(
      `export function test(): number { return +true; }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("+false produces 0", async () => {
    await assertEquivalent(
      `export function test(): number { return +false; }`,
      [{ fn: "test", args: [] }],
    );
  });

  it('+\"42\" produces 42', async () => {
    await assertEquivalent(
      `export function test(): number { return +"42"; }`,
      [{ fn: "test", args: [] }],
    );
  });
});

// ── Issue #175: Negative zero preservation in modulus ──
describe("negative zero modulus (#175)", () => {
  it("-1 % -1 produces -0", async () => {
    await assertEquivalent(
      `export function test(): number { return 1 / (-1 % -1); }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("(-1) % 1 produces -0", async () => {
    await assertEquivalent(
      `export function test(): number { return 1 / ((-1) % 1); }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("7 % 3 produces 1 (positive case unchanged)", async () => {
    await assertEquivalent(
      `export function test(): number { return 7 % 3; }`,
      [{ fn: "test", args: [] }],
    );
  });
});

// ── Issue #183: Template literal type coercion ──
describe("template literal type coercion (#183)", () => {
  it("template with number substitution", async () => {
    await assertEquivalent(
      `export function test(): string { return \`value: \${42}\`; }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("template with multiple number substitutions", async () => {
    await assertEquivalent(
      `export function test(): string {
        return \`\${1} + \${2} = \${3}\`;
      }`,
      [{ fn: "test", args: [] }],
    );
  });
});

// ── Issue #193: Coalesce operator type mismatch ──
describe("coalesce operator type unification (#193)", () => {
  it("null string ?? default returns default", async () => {
    await assertEquivalent(
      `export function test(): string {
        const x: string | null = null;
        return x ?? "default";
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("non-null string ?? fallback returns original", async () => {
    await assertEquivalent(
      `export function test(): string {
        const x: string | null = "hello";
        return x ?? "default";
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("undefined string ?? default returns default", async () => {
    await assertEquivalent(
      `export function test(): string {
        const x: string | undefined = undefined;
        return x ?? "default";
      }`,
      [{ fn: "test", args: [] }],
    );
  });
});

describe("prefix/postfix increment on property access (#195)", () => {
  it("prefix increment on object property", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let obj = { x: 5 };
        let result = ++obj.x;
        return result + obj.x;  // 6 + 6 = 12
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("prefix decrement on object property", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let obj = { x: 10 };
        let result = --obj.x;
        return result + obj.x;  // 9 + 9 = 18
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("postfix increment on object property", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let obj = { x: 5 };
        let result = obj.x++;
        return result + obj.x;  // 5 + 6 = 11
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("postfix decrement on object property", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let obj = { x: 10 };
        let result = obj.x--;
        return result + obj.x;  // 10 + 9 = 19
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("prefix increment on array element", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let arr = [1, 2, 3];
        let result = ++arr[1];
        return result + arr[1];  // 3 + 3 = 6
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("postfix increment on array element", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let arr = [1, 2, 3];
        let result = arr[1]++;
        return result + arr[1];  // 2 + 3 = 5
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("multiple increments on same property", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let obj = { count: 0 };
        obj.count++;
        obj.count++;
        ++obj.count;
        return obj.count;  // 3
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("increment property in expression", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let obj = { a: 1, b: 10 };
        return obj.a++ + ++obj.b;  // 1 + 11 = 12
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});

describe("compound assignment on property access (#195)", () => {
  it("obj.prop += value", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let obj = { x: 10 };
        obj.x += 5;
        return obj.x;  // 15
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("obj.prop -= value", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let obj = { x: 10 };
        obj.x -= 3;
        return obj.x;  // 7
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("obj.prop *= value", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let obj = { x: 5 };
        obj.x *= 4;
        return obj.x;  // 20
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("arr[i] += value", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let arr = [10, 20, 30];
        arr[1] += 5;
        return arr[1];  // 25
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("compound assignment returns new value", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let obj = { x: 10 };
        let result = (obj.x += 5);
        return result;  // 15
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});

describe("Function arity mismatch (#184)", () => {
  it("calling function with fewer args than params", async () => {
    // In Wasm, f64 default is 0 (not undefined), so f(5) => 5 + 0 = 5
    const exports = await compileToWasm(`
      function f(a: number, b: number): number {
        return a + b;
      }
      export function test(): number {
        return f(5);
      }
    `);
    expect(exports.test()).toBe(5);
  });

  it("calling function with zero args when it expects two", async () => {
    // In Wasm, f64 default is 0, so f() => 0 + 0 = 0
    const exports = await compileToWasm(`
      function f(a: number, b: number): number {
        return a + b;
      }
      export function test(): number {
        return f();
      }
    `);
    expect(exports.test()).toBe(0);
  });

  it("class constructor with fewer args than params", async () => {
    const exports = await compileToWasm(`
      class Point {
        x: number;
        y: number;
        constructor(x: number, y: number) {
          this.x = x;
          this.y = y;
        }
        getX(): number { return this.x; }
        getY(): number { return this.y; }
      }
      export function test(): number {
        const p = new Point(42);
        return p.getX();
      }
    `);
    expect(exports.test()).toBe(42);
  });

  it("class constructor with no args when it expects params", async () => {
    const exports = await compileToWasm(`
      class Pair {
        a: number;
        b: number;
        constructor(a: number, b: number) {
          this.a = a;
          this.b = b;
        }
        sum(): number { return this.a + this.b; }
      }
      export function test(): number {
        const p = new Pair();
        return p.sum();
      }
    `);
    expect(exports.test()).toBe(0);
  });
});

describe("Spread in new expressions (#177)", () => {
  it("new with spread array literal", async () => {
    const exports = await compileToWasm(`
      class Vec {
        x: number;
        y: number;
        z: number;
        constructor(x: number, y: number, z: number) {
          this.x = x;
          this.y = y;
          this.z = z;
        }
        sum(): number { return this.x + this.y + this.z; }
      }
      export function test(): number {
        const v = new Vec(...[3, 4, 5]);
        return v.sum();
      }
    `);
    expect(exports.test()).toBe(12);
  });
});

describe("Arguments object in nested functions (#211)", () => {
  it("arguments.length in nested function", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        function inner(a: number, b: number, c: number): number {
          return arguments.length;
        }
        return inner(1, 2, 3);
      }
    `);
    expect(exports.test()).toBe(3);
  });

  it("for-loop with continue", async () => {
    await assertEquivalent(
      `
      export function test(): string {
        let s = "";
        for (let i = 0; i < 10; i++) {
          if (i < 5) continue;
          s += i;
        }
        return s;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("for-loop with break", async () => {
    await assertEquivalent(
      `
      export function test(): string {
        let s = "";
        for (let i = 0; i < 10; i++) {
          if (i > 5) break;
          s += i;
        }
        return s;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("nested for-loop with labeled continue", async () => {
    await assertEquivalent(
      `
      export function test(): string {
        let s = "";
        outer: for (let i = 0; i < 4; i++) {
          inner: for (let j = 0; j <= i; j++) {
            if (i * j === 6) continue outer;
            s += "" + i + j;
          }
        }
        return s;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("nested for-loop with labeled break", async () => {
    await assertEquivalent(
      `
      export function test(): string {
        let s = "";
        outer: for (let i = 0; i < 4; i++) {
          inner: for (let j = 0; j <= i; j++) {
            if (i * j >= 4) break outer;
            s += "" + i + j;
          }
        }
        return s;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("while loop with complex condition", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let x = 10;
        let sum = 0;
        while (x > 0 && sum < 30) {
          sum += x;
          x -= 3;
        }
        return sum;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("do-while with continue", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let i = 0;
        let sum = 0;
        do {
          i++;
          if (i % 2 === 0) continue;
          sum += i;
        } while (i < 10);
        return sum;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("for-of destructuring object", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const items = [{ a: 1, b: 2 }, { a: 3, b: 4 }];
        let sum = 0;
        for (const { a, b } of items) {
          sum += a + b;
        }
        return sum;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });


  it("do-while with break", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let i = 0;
        let sum = 0;
        do {
          i++;
          sum += i;
          if (sum > 10) break;
        } while (i < 100);
        return sum;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("while loop with assignment in condition", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let arr = [1, 2, 3, 4, 5];
        let sum = 0;
        let i = 0;
        while (i < arr.length) {
          sum += arr[i];
          i++;
        }
        return sum;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("for-loop with function declaration in body", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let result = 0;
        for (let i = 0; i < 3; i++) {
          function addI(x: number): number { return x + i; }
          result += addI(10);
        }
        return result;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("nested for-loop continue interaction", async () => {
    await assertEquivalent(
      `
      export function test(): string {
        let s = "";
        for (let i = 0; i < 4; i++) {
          for (let j = 0; j <= i; j++) {
            if (i * j === 6) continue;
            s += "" + i + j;
          }
        }
        return s;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("for-of with simple variable", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const arr = [10, 20, 30];
        let sum = 0;
        for (const x of arr) {
          sum += x;
        }
        return sum;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });


  // Issue #200: JSON.stringify/parse with various argument types
  it("JSON.stringify with number", async () => {
    await assertEquivalent(
      `
      export function test(): string {
        return JSON.stringify(42);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("JSON.parse with string", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        return JSON.parse("42");
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  // Issue #205: String.prototype.indexOf with start position
  it("string indexOf with start position", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var s: string = "hello world hello";
        return s.indexOf("hello", 1);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("string indexOf without start position", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var s: string = "hello world";
        return s.indexOf("world");
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  // Issue #181: new Object()
  it("new Object() creates empty object", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        var o: any = new Object();
        return 42;
      }
    `);
    expect(exports.test()).toBe(42);
  });

  // Issue #251: super() call required in derived class constructors — diagnostic suppressed
  it("derived class without explicit super compiles", async () => {
    const exports = await compileToWasm(`
      class Base {
        getVal(): number { return 42; }
      }
      class Child extends Base {
        run(): number { return this.getVal(); }
      }
      export function test(): number {
        var c = new Child();
        return c.run();
      }
    `);
    expect(exports.test()).toBe(42);
  });

  // Issue #252: var re-declaration with different types
  it("var re-declaration with different value", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        var x: number = 1;
        var x: number = 42;
        return x;
      }
    `);
    expect(exports.test()).toBe(42);
  });

  // Issue #255: 'this' implicit any type in class methods
  it("this in class method compiles", async () => {
    const exports = await compileToWasm(`
      class Counter {
        count: number = 0;
        increment(): void {
          this.count = this.count + 1;
        }
        getCount(): number {
          return this.count;
        }
      }
      export function test(): number {
        var c = new Counter();
        c.increment();
        c.increment();
        return c.getCount();
      }
    `);
    expect(exports.test()).toBe(2);
  });

  // Issue #240: Setter with return value
  it("setter with return statement compiles", async () => {
    const exports = await compileToWasm(`
      class Box {
        _value: number = 0;
        get value(): number { return this._value; }
        set value(v: number) { this._value = v; }
      }
      export function test(): number {
        var b = new Box();
        b.value = 99;
        return b.value;
      }
    `);
    expect(exports.test()).toBe(99);
  });

  // Issue #225: string !== comparison with any-typed variable
  it("string !== comparison (any-typed var vs string literal)", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var s: string = "";
        for (var i: number = 0; i < 10; i += 1) {
          if (i < 5) continue;
          s += i;
        }
        if (s !== "56789") {
          return 0;
        }
        return 1;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  // Issue #225: string === comparison
  it("string === comparison (typed variables)", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let a: string = "hello";
        let b: string = "hel" + "lo";
        if (a === b) {
          return 1;
        }
        return 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  // Issue #225: string !== with loop-built string (test262 pattern)
  it("for-loop continue with string !== check", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var __str = "";
        for (var index = 0; index < 10; index += 1) {
          if (index < 5) continue;
          __str += index;
        }
        if (__str !== "56789") {
          return 0;
        }
        return 1;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  // Issue #245: switch statement with string case values
  it("switch with string case values", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let x: string = "b";
        let result: number = 0;
        switch (x) {
          case "a":
            result = 1;
            break;
          case "b":
            result = 2;
            break;
          case "c":
            result = 3;
            break;
          default:
            result = -1;
        }
        return result;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  // Issue #245: switch with string case values and fallthrough
  it("switch with string case values and fallthrough", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let x: string = "a";
        let result: number = 0;
        switch (x) {
          case "a":
            result += 1;
          case "b":
            result += 10;
            break;
          case "c":
            result += 100;
            break;
        }
        return result;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  // Issue #245: switch with string default case
  it("switch with string case values - default case", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let x: string = "z";
        let result: number = 0;
        switch (x) {
          case "a":
            result = 1;
            break;
          case "b":
            result = 2;
            break;
          default:
            result = 99;
        }
        return result;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  // Issue #256: nested function declarations in for loops
  it("nested function declaration in for loop body", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var result: number = 0;
        for (var i: number = 0; i < 3; i++) {
          function add10(): number { return 10; }
          result = result + add10();
        }
        return result;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  // Issue #256: nested function declarations in while loops
  it("nested function declaration in while loop body", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var count: number = 0;
        var done: boolean = false;
        while (!done) {
          function inc(): number { return 1; }
          count = count + inc();
          if (count >= 5) done = true;
        }
        return count;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  // Issue #256: nested function declarations in switch cases
  it("nested function declaration in switch case", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var x: number = 2;
        switch (x) {
          case 2: {
            function getVal(): number { return 99; }
            return getVal();
          }
          default:
            return 0;
        }
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  // Issue #256: nested function declaration in do-while loop
  it("nested function declaration in do-while loop", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var result: number = 0;
        var count: number = 0;
        do {
          function getInc(): number { return 7; }
          result = result + getInc();
          count = count + 1;
        } while (count < 2);
        return result;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  // Issue #248: Logical operators with null/undefined operands
  it("logical AND returns null when RHS is null (#248)", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        if ((true && null) !== null) return 0;
        return 1;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("logical OR returns null when RHS is null (#248)", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        if ((false || null) !== null) return 0;
        return 1;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  // Issue #226: valueOf coercion on comparison operators
  it("comparison operators invoke valueOf on object literals (#226)", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        var obj1 = {
          valueOf: function () { return 3; }
        };
        var obj2 = {
          valueOf: function () { return 5; }
        };
        let result = 0;
        if (obj1 < obj2) result += 1;
        if (obj1 > obj2) result += 10;
        if (obj1 <= obj2) result += 100;
        if (obj1 >= obj2) result += 1000;
        return result;
      }
    `);
    // 3 < 5: true (+1), 3 > 5: false, 3 <= 5: true (+100), 3 >= 5: false
    expect(exports.test()).toBe(101);
  });

  it("valueOf with captured variables (#226)", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        var accessed = false;
        var obj = {
          valueOf: function () {
            accessed = true;
            return 42;
          }
        };
        var obj2 = {
          valueOf: function () { return 10; }
        };
        if (!(obj > obj2)) return 0;
        if (!accessed) return 0;
        return 1;
      }
    `);
    expect(exports.test()).toBe(1);
  });

});

// ── in operator edge cases (#244) ──────────────────────────────
describe("in operator edge cases", () => {
  it("known property is 'in' the object", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        const obj = { x: 1, y: 2 };
        if (!("x" in obj)) return 0;
        if (!("y" in obj)) return 0;
        return 1;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("valueOf is 'in' any object (prototype property)", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        const obj: Record<string, any> = {};
        if (!("valueOf" in obj)) return 0;
        return 1;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("toString is 'in' any object (prototype property)", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        const obj = { a: 1 };
        if (!("toString" in obj)) return 0;
        return 1;
      }
    `);
    expect(exports.test()).toBe(1);
  });
});
