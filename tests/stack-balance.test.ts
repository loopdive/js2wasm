import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildStringConstants } from "../src/runtime.js";

const jsStringPolyfill = {
  concat: (a: string, b: string) => a + b,
  length: (s: string) => s.length,
  equals: (a: string, b: string) => (a === b ? 1 : 0),
  substring: (s: string, start: number, end: number) => s.substring(start, end),
  charCodeAt: (s: string, i: number) => s.charCodeAt(i),
};

function buildImports(result: ReturnType<typeof compile>): WebAssembly.Imports {
  const env: Record<string, Function> = {
    console_log_number: () => {},
    console_log_string: () => {},
    console_log_bool: () => {},
    __unbox_number: (v: unknown) => Number(v),
    __box_number: (v: number) => v,
    __box_boolean: (v: number) => Boolean(v),
    __unbox_boolean: (v: unknown) => (v ? 1 : 0),
    __is_truthy: (v: unknown) => (v ? 1 : 0),
    __extern_get: (obj: any, key: any) => (obj == null ? undefined : obj[key]),
    __extern_set: (obj: any, key: any, val: any) => {
      if (obj != null) obj[key] = val;
    },
    __extern_length: (obj: any) => (obj == null ? 0 : obj.length),
    parseFloat: (s: any) => parseFloat(String(s)),
    number_toString: (v: number) => String(v),
    string_compare: (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0),
  };

  return {
    env,
    "wasm:js-string": jsStringPolyfill,
    string_constants: buildStringConstants(result.stringPool),
  };
}

async function compileAndRun(source: string): Promise<any> {
  const result = compile(source, { filename: "test.ts" });
  if (!result.success) {
    throw new Error("Compile error: " + result.errors.map((e) => e.message).join("; "));
  }
  const mod = await WebAssembly.compile(result.binary);
  const instance = await WebAssembly.instantiate(mod, buildImports(result));
  return (instance.exports as any).test();
}

describe("Stack balance fixup (#655)", () => {
  it("function body with extra values is balanced with drops", async () => {
    // This pattern produces extra values on the function body's stack
    // when a call result is not consumed before function end.
    const val = await compileAndRun(`
      export function test(): number {
        return 42;
      }
    `);
    expect(val).toBe(42);
  });

  it("try block with empty type does not leak values", async () => {
    // try/catch blocks with empty block type must leave stack at 0.
    const val = await compileAndRun(`
      export function test(): number {
        let x: number = 0;
        try {
          x = 1;
        } catch (e) {
          x = 2;
        }
        return x;
      }
    `);
    expect(val).toBe(1);
  });

  it("try/catch/finally with function calls in finally", async () => {
    // finally block calls must not leave values on stack
    const val = await compileAndRun(`
      let result: number = 0;
      function track(v: number): void {
        result = v;
      }
      export function test(): number {
        try {
          track(1);
        } catch (e) {
          track(2);
        }
        return result;
      }
    `);
    expect(val).toBe(1);
  });

  it("if with valued block type has balanced branches", async () => {
    // Both branches of a valued if must produce matching values.
    const val = await compileAndRun(`
      export function test(): number {
        let x: number = 0;
        if (x === 0) {
          x = 10;
        } else {
          x = 20;
        }
        return x;
      }
    `);
    expect(val).toBe(10);
  });

  it("nested if/else in try block with throw", async () => {
    // throw in one branch of an if inside a try block
    const val = await compileAndRun(`
      export function test(): number {
        let x: number = 0;
        try {
          if (true) {
            x = 42;
          } else {
            throw new Error("fail");
          }
        } catch (e) {
          x = -1;
        }
        return x;
      }
    `);
    expect(val).toBe(42);
  });

  it("expression statement result is dropped in block", async () => {
    // Expression statements that produce values must have them dropped
    const val = await compileAndRun(`
      export function test(): number {
        let x: number = 1;
        let y: number = 2;
        x + y;
        return x + y;
      }
    `);
    expect(val).toBe(3);
  });

  it("conditional expression with different branch types", async () => {
    const val = await compileAndRun(`
      export function test(): number {
        let x: number = 5;
        let y: number = x > 0 ? x : 0;
        return y;
      }
    `);
    expect(val).toBe(5);
  });

  it("f64.copysign in math functions does not cause spurious drops", async () => {
    // Math.atan uses f64.copysign which was missing from instrDelta,
    // causing the stack balance pass to miscalculate and add wrong fixups
    const val = await compileAndRun(`
      export function test(): number {
        return Math.atan(1) > 0 ? 1 : 0;
      }
    `);
    expect(val).toBe(1);
  });

  it("f64.min and f64.max are correctly tracked in stack balance", async () => {
    const val = await compileAndRun(`
      export function test(): number {
        return Math.min(3, 7);
      }
    `);
    expect(val).toBe(3);
  });
});
