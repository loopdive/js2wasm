import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

async function run(src: string): Promise<number> {
  const r = compile(src, { fileName: "test.ts" });
  if (!r.success) throw new Error("CE: " + r.errors[0]?.message);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  return (instance.exports as any).test();
}

describe("Issue #786: block-scoped let/const shadowing", () => {
  it("inner let does not leak to outer scope", async () => {
    const result = await run(`
      export function test(): number {
        let x: number = 2;
        {
          let x: number = 3;
        }
        return x;
      }
    `);
    expect(result).toBe(2);
  });

  it("nested let shadowing restores all levels", async () => {
    const result = await run(`
      export function test(): number {
        let x: number = 1;
        {
          let x: number = 2;
          {
            let x: number = 3;
          }
        }
        return x;
      }
    `);
    expect(result).toBe(1);
  });

  it("inner let value accessible inside block", async () => {
    const result = await run(`
      export function test(): number {
        let x: number = 10;
        let r: number = 0;
        {
          let x: number = 20;
          r = x;
        }
        return r + x;
      }
    `);
    expect(result).toBe(30);
  });

  it("var is not block-scoped (unchanged behavior)", async () => {
    const result = await run(`
      export function test(): number {
        var x: number = 2;
        {
          var x: number = 3;
        }
        return x;
      }
    `);
    expect(result).toBe(3);
  });

  it("for-loop let scope does not leak", async () => {
    const result = await run(`
      export function test(): number {
        let x: number = 10;
        for (let x: number = 0; x < 3; x = x + 1) {
          // inner x
        }
        return x;
      }
    `);
    expect(result).toBe(10);
  });

  it("catch parameter scope does not leak", async () => {
    const result = await run(`
      export function test(): number {
        let result: number = 0;
        let c: number = 1;
        try {
          throw 42;
        } catch (e) {
          result = 10;
        }
        return c;
      }
    `);
    expect(result).toBe(1);
  });
});

describe("Issue #786: method closure captures", () => {
  it("object method can read/write enclosing var", async () => {
    const result = await run(`
      export function test(): number {
        var callCount: number = 0;
        var obj = {
          inc(): void { callCount = callCount + 1; }
        };
        obj.inc();
        if (callCount === 1) return 1;
        return 0;
      }
    `);
    expect(result).toBe(1);
  });

  it("object method captures multiple variables", async () => {
    const result = await run(`
      export function test(): number {
        var a: number = 10;
        var b: number = 20;
        var obj = {
          swap(): void {
            var t: number = a;
            a = b;
            b = t;
          }
        };
        obj.swap();
        if (a === 20 && b === 10) return 1;
        return 0;
      }
    `);
    expect(result).toBe(1);
  });

  it("nested class method can read/write enclosing var", async () => {
    const result = await run(`
      export function test(): number {
        var callCount: number = 0;
        class C {
          inc(): void { callCount = callCount + 1; }
        }
        var c = new C();
        c.inc();
        if (callCount === 1) return 1;
        return 0;
      }
    `);
    expect(result).toBe(1);
  });

  it("method callCount pattern (test262 common case)", async () => {
    const result = await run(`
      export function test(): number {
        var callCount: number = 0;
        var obj = {
          method(x: number, y: number, z: number): void {
            callCount = callCount + 1;
          }
        };
        obj.method(1, 2, 3);
        if (callCount === 1) return 1;
        return 0;
      }
    `);
    expect(result).toBe(1);
  });
});
