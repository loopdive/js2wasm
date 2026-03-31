import { describe, it, expect } from "vitest";
import {
  compileToWasm,
  evaluateAsJs,
  assertEquivalent,
  buildImports,
  compile,
  readFileSync,
  resolve,
} from "./helpers.js";

describe("Gradual typing: boxed any (fast mode)", () => {
  /**
   * Compile TS source to Wasm in fast mode, instantiate it, and return exports.
   */
  async function compileFast(source: string) {
    const result = compile(source, { fast: true });
    if (!result.success) {
      throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
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

  it("any in conditional (if statement)", async () => {
    const exports = await compileFast(`
      export function test(x: number): number {
        let a: any = x;
        if (a) return 1;
        return 0;
      }
    `);
    expect(exports.test(5)).toBe(1);
    expect(exports.test(0)).toBe(0);
    expect(exports.test(-1)).toBe(1);
  });

  it("any in ternary expression", async () => {
    const exports = await compileFast(`
      export function test(x: number): number {
        let a: any = x;
        return a ? 1 : 0;
      }
    `);
    expect(exports.test(5)).toBe(1);
    expect(exports.test(0)).toBe(0);
  });

  it("any === any: strict equality", async () => {
    const exports = await compileFast(`
      export function test(x: number, y: number): number {
        let a: any = x;
        let b: any = y;
        return (a === b) ? 1 : 0;
      }
    `);
    expect(exports.test(5, 5)).toBe(1);
    expect(exports.test(5, 6)).toBe(0);
  });

  it("any !== any: strict inequality", async () => {
    const exports = await compileFast(`
      export function test(x: number, y: number): number {
        let a: any = x;
        let b: any = y;
        return (a !== b) ? 1 : 0;
      }
    `);
    expect(exports.test(5, 5)).toBe(0);
    expect(exports.test(5, 6)).toBe(1);
  });

  it("any compound assignment +=", async () => {
    const exports = await compileFast(`
      export function test(x: number): number {
        let a: any = x;
        a += 1;
        return a as number;
      }
    `);
    expect(exports.test(5)).toBe(6);
    expect(exports.test(0)).toBe(1);
    expect(exports.test(-3)).toBe(-2);
  });

  it("any compound assignment -=", async () => {
    const exports = await compileFast(`
      export function test(x: number): number {
        let a: any = x;
        a -= 3;
        return a as number;
      }
    `);
    expect(exports.test(10)).toBe(7);
    expect(exports.test(0)).toBe(-3);
  });

  it("any null boxing — truthiness", async () => {
    const exports = await compileFast(`
      export function test(): number {
        let a: any = null;
        return a ? 1 : 0;
      }
    `);
    expect(exports.test()).toBe(0);
  });

  it("any undefined boxing — truthiness", async () => {
    const exports = await compileFast(`
      export function test(): number {
        let a: any = undefined;
        return a ? 1 : 0;
      }
    `);
    expect(exports.test()).toBe(0);
  });

  it("any boolean boxing and unboxing", async () => {
    const exports = await compileFast(`
      export function testTrue(): number {
        let a: any = true;
        return a ? 1 : 0;
      }
      export function testFalse(): number {
        let b: any = false;
        return b ? 1 : 0;
      }
    `);
    expect(exports.testTrue()).toBe(1);
    expect(exports.testFalse()).toBe(0);
  });

  it("any type used as function return", async () => {
    const exports = await compileFast(`
      function identity(x: any): any {
        return x;
      }
      export function test(x: number): number {
        let result: any = identity(x);
        return result as number;
      }
    `);
    expect(exports.test(42)).toBe(42);
    expect(exports.test(-7)).toBe(-7);
  });

  it("any mixed arithmetic: any + any with different box paths", async () => {
    const exports = await compileFast(`
      export function test(x: number, y: number): number {
        let a: any = x;
        let b: any = y;
        let c: any = a + b;
        let d = (c as number) + 1;
        return d;
      }
    `);
    expect(exports.test(3, 4)).toBe(8);
    expect(exports.test(0, 0)).toBe(1);
  });

  it("any unary plus coercion", async () => {
    const exports = await compileFast(`
      export function test(x: number): number {
        let a: any = x;
        return +a;
      }
    `);
    expect(exports.test(42)).toBe(42);
    expect(exports.test(-5)).toBe(-5);
  });

  it("any double negation (!!a)", async () => {
    const exports = await compileFast(`
      export function test(x: number): number {
        let a: any = x;
        return !!a ? 1 : 0;
      }
    `);
    expect(exports.test(5)).toBe(1);
    expect(exports.test(0)).toBe(0);
  });

  it("any-typed variable reassignment", async () => {
    const exports = await compileFast(`
      export function test(): number {
        let a: any = 10;
        a = 20;
        return a as number;
      }
    `);
    expect(exports.test()).toBe(20);
  });

  it("any in while loop condition", async () => {
    const exports = await compileFast(`
      export function test(x: number): number {
        let a: any = x;
        let count: number = 0;
        while ((a as number) > 0) {
          count += 1;
          a = (a as number) - 1;
        }
        return count;
      }
    `);
    expect(exports.test(3)).toBe(3);
    expect(exports.test(0)).toBe(0);
  });

  it("typeof any boolean: runtime tag check", async () => {
    const exports = await compileFast(`
      export function testBool(): number {
        let a: any = true;
        if (typeof a === "boolean") return 1;
        return 0;
      }
      export function testNum(): number {
        let a: any = 42;
        if (typeof a === "number") return 1;
        return 0;
      }
    `);
    expect(exports.testBool()).toBe(1);
    expect(exports.testNum()).toBe(1);
  });

  it("any passed to typed function parameter", async () => {
    const exports = await compileFast(`
      function add(a: number, b: number): number { return a + b; }
      export function test(x: number): number {
        let a: any = x;
        return add(a as number, 1);
      }
    `);
    expect(exports.test(10)).toBe(11);
    expect(exports.test(0)).toBe(1);
  });
});
