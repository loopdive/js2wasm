import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

async function runCode(src: string): Promise<any> {
  const r = compile(src, { fileName: "test.ts" });
  if (!r.success) throw new Error("Compile error: " + r.errors[0]?.message);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  return (instance.exports as any).test();
}

describe("Issue #813: gen.next is not a function — private/public method name collision", () => {
  it("class with both private method #m() and generator *m() should not collide", async () => {
    const result = await runCode(`
      class C {
        #m() { return 42; }
        *m() { return 99; }
        getPrivate(): number {
          return this.#m();
        }
      }
      export function test(): number {
        const c = new C();
        const priv = c.getPrivate();
        const gen = c.m();
        const genResult = gen.next();
        if (priv !== 42) return 2;
        if (genResult.value !== 99) return 3;
        return 1;
      }
    `);
    expect(result).toBe(1);
  });

  it("private field #x and public field x should not collide", async () => {
    const result = await runCode(`
      class C {
        #x: number;
        x: number;
        constructor() {
          this.#x = 10;
          this.x = 20;
        }
        getPrivate(): number {
          return this.#x;
        }
      }
      export function test(): number {
        const c = new C();
        if (c.getPrivate() !== 10) return 2;
        if (c.x !== 20) return 3;
        return 1;
      }
    `);
    expect(result).toBe(1);
  });

  it("private method still works after renaming", async () => {
    const result = await runCode(`
      class Counter {
        #count: number;
        constructor() {
          this.#count = 0;
        }
        #increment() {
          this.#count = this.#count + 1;
        }
        tick(): number {
          this.#increment();
          return this.#count;
        }
      }
      export function test(): number {
        const c = new Counter();
        c.tick();
        c.tick();
        return c.tick();
      }
    `);
    expect(result).toBe(3);
  });
});
