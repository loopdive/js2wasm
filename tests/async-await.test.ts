import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

describe("async/await support", () => {
  it("async function returning a number compiles and runs", async () => {
    const result = compile(`
      export async function getNum(): Promise<number> {
        return 42;
      }
    `);
    expect(
      result.success,
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    ).toBe(true);

    const { instance } = await WebAssembly.instantiate(result.binary, {
      env: {},
    });
    const exports = instance.exports as any;
    expect(exports.getNum()).toBe(42);
  });

  it("await on a host-provided value", async () => {
    const result = compile(`
      declare namespace Host {
        class DataService {
          constructor();
          fetchValue(): number;
        }
      }
      export async function getValue(): Promise<number> {
        const svc = new Host.DataService();
        const val = await svc.fetchValue();
        return val;
      }
    `);
    expect(
      result.success,
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    ).toBe(true);

    const { instance } = await WebAssembly.instantiate(result.binary, {
      env: {
        Host_DataService_new: () => ({}),
        Host_DataService_fetchValue: () => 99,
      },
    });
    const exports = instance.exports as any;
    expect(exports.getValue()).toBe(99);
  });

  it("async function with multiple sequential awaits", async () => {
    const result = compile(`
      declare namespace Host {
        class Api {
          constructor();
          getA(): number;
          getB(): number;
        }
      }
      export async function sumTwo(): Promise<number> {
        const api = new Host.Api();
        const a = await api.getA();
        const b = await api.getB();
        return a + b;
      }
    `);
    expect(
      result.success,
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    ).toBe(true);

    const { instance } = await WebAssembly.instantiate(result.binary, {
      env: {
        Host_Api_new: () => ({}),
        Host_Api_getA: () => 10,
        Host_Api_getB: () => 20,
      },
    });
    const exports = instance.exports as any;
    expect(exports.sumTwo()).toBe(30);
  });

  it("async void function compiles and runs", async () => {
    const result = compile(`
      export async function doWork(): Promise<void> {
        const x = 1 + 2;
      }
    `);
    expect(
      result.success,
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    ).toBe(true);

    const { instance } = await WebAssembly.instantiate(result.binary, {
      env: {},
    });
    const exports = instance.exports as any;
    // void function should be callable without error
    expect(() => exports.doWork()).not.toThrow();
  });

  it("Promise<number> return type maps correctly in .d.ts", () => {
    const result = compile(`
      export async function compute(): Promise<number> {
        return 5;
      }
    `);
    expect(result.success).toBe(true);
    expect(result.dts).toContain("Promise<number>");
    expect(result.dts).toContain("compute");
  });

  it("async function with arithmetic on awaited values", async () => {
    const result = compile(`
      declare namespace Host {
        class Calc {
          constructor();
          getX(): number;
          getY(): number;
        }
      }
      export async function calculate(): Promise<number> {
        const c = new Host.Calc();
        const x = await c.getX();
        const y = await c.getY();
        return x * y + 1;
      }
    `);
    expect(
      result.success,
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    ).toBe(true);

    const { instance } = await WebAssembly.instantiate(result.binary, {
      env: {
        Host_Calc_new: () => ({}),
        Host_Calc_getX: () => 7,
        Host_Calc_getY: () => 3,
      },
    });
    const exports = instance.exports as any;
    expect(exports.calculate()).toBe(22); // 7 * 3 + 1
  });

  it("async function with boolean return", async () => {
    const result = compile(`
      export async function check(): Promise<boolean> {
        return true;
      }
    `);
    expect(
      result.success,
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    ).toBe(true);

    const { instance } = await WebAssembly.instantiate(result.binary, {
      env: {},
    });
    const exports = instance.exports as any;
    expect(exports.check()).toBe(1); // boolean true = i32(1)
  });

  it("non-async function is not marked as async in .d.ts", () => {
    const result = compile(`
      export function syncFn(): number { return 1; }
      export async function asyncFn(): Promise<number> { return 2; }
    `);
    expect(result.success).toBe(true);
    // syncFn should not have Promise wrapper
    expect(result.dts).toContain("syncFn(): number;");
    // asyncFn should have Promise wrapper
    expect(result.dts).toContain("asyncFn(): Promise<number>;");
  });
});
