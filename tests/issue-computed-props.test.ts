import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

async function runTest(source: string): Promise<number> {
  const result = compile(source, { fileName: "test.ts" });
  if (!result.success) {
    throw new Error(`Compilation failed: ${result.errors.map((e) => e.message).join("; ")}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return (instance.exports as { test: () => number }).test();
}

describe("computed property names", () => {
  it("const variable computed key in object literal", async () => {
    const result = await runTest(`
      const key = "value";
      const obj = { [key]: 42 };
      export function test(): number {
        return obj.value === 42 ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });

  it("string concatenation computed key", async () => {
    const result = await runTest(`
      const prefix = "get";
      const obj = { [prefix + "Name"]: "Alice" };
      export function test(): number {
        return obj.getName === "Alice" ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });

  it("multiple computed properties with static mix", async () => {
    const result = await runTest(`
      const k1 = "a";
      const k2 = "b";
      const obj = { [k1]: 1, [k2]: 2, c: 3 };
      export function test(): number {
        if (obj.a !== 1) return 0;
        if (obj.b !== 2) return 0;
        if (obj.c !== 3) return 0;
        return 1;
      }
    `);
    expect(result).toBe(1);
  });

  it("computed method name in class", async () => {
    const result = await runTest(`
      const ACTION = "doSomething";
      class MyClass {
        [ACTION](): number { return 99; }
      }
      export function test(): number {
        const inst = new MyClass();
        return inst.doSomething() === 99 ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });

  it("const enum computed key", async () => {
    const result = await runTest(`
      const enum Direction {
        Up = "UP",
        Down = "DOWN",
      }
      const obj = { [Direction.Up]: 1, [Direction.Down]: 2 };
      export function test(): number {
        if (obj.UP !== 1) return 0;
        if (obj.DOWN !== 2) return 0;
        return 1;
      }
    `);
    expect(result).toBe(1);
  });

  it("destructuring with computed key", async () => {
    const result = await runTest(`
      const key = "name";
      function getObj() { return { name: "Bob", age: 25 }; }
      export function test(): number {
        const { [key]: personName } = getObj();
        return personName === "Bob" ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });

  it("template literal computed key", async () => {
    const result = await runTest(`
      const base = "prop";
      const obj = { [\`\${base}1\`]: 10, [\`\${base}2\`]: 20 };
      export function test(): number {
        if (obj.prop1 !== 10) return 0;
        if (obj.prop2 !== 20) return 0;
        return 1;
      }
    `);
    expect(result).toBe(1);
  });

  it("computed key in local object literal", async () => {
    const result = await runTest(`
      export function test(): number {
        const key = "value";
        const obj = { [key]: 42 };
        return obj.value === 42 ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });
});
