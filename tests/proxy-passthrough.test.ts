import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function run(source: string, fn: string, args: unknown[] = []): Promise<unknown> {
  const result = compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
  const { instance } = await WebAssembly.instantiate(result.binary, { env: {} });
  return (instance.exports as any)[fn](...args);
}

describe("Proxy pass-through (issue #498 tier 0)", () => {
  it("new Proxy(target, {}) returns target value for struct property access", async () => {
    const src = `
      class Point {
        x: number;
        y: number;
        constructor(x: number, y: number) {
          this.x = x;
          this.y = y;
        }
      }
      export function test(): number {
        const target = new Point(10, 20);
        const proxy = new Proxy(target, {});
        return proxy.x + proxy.y;
      }
    `;
    expect(await run(src, "test")).toBe(30);
  });

  it("new Proxy(target, handler) with get trap compiles as pass-through", async () => {
    const src = `
      class Box {
        value: number;
        constructor(v: number) { this.value = v; }
      }
      export function test(): number {
        const obj = new Box(42);
        const p = new Proxy(obj, {
          get(t: Box, prop: string) { return 0; }
        });
        // In pass-through mode, the get trap is ignored — p.value reads from target directly
        return p.value;
      }
    `;
    expect(await run(src, "test")).toBe(42);
  });

  it("proxy of simple object passes through field reads", async () => {
    const src = `
      export function test(): number {
        const target = { a: 3, b: 7 };
        const proxy = new Proxy(target, {});
        return proxy.a * proxy.b;
      }
    `;
    expect(await run(src, "test")).toBe(21);
  });
});
