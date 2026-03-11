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
