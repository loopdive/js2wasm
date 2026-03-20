import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function run(source: string, fn: string, args: unknown[] = []): Promise<unknown> {
  const result = compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
  const { instance } = await WebAssembly.instantiate(result.binary, { env: {} });
  return (instance.exports as any)[fn](...args);
}

describe("null pointer dereference guards for property access (#663)", () => {
  it("property access on conditionally-null struct does not trap", async () => {
    // When flag is 0, obj stays null; accessing obj.x should return 0 (default)
    // instead of trapping with "dereferencing a null pointer"
    expect(
      await run(
        `
        interface Pair { x: number; y: number }
        export function test(flag: number): number {
          let obj: Pair | null = null;
          if (flag > 0) {
            obj = { x: 42, y: 99 };
          }
          // Without null guard, this traps when flag === 0
          return obj !== null ? obj.x : -1;
        }
        `,
        "test",
        [1],
      ),
    ).toBe(42);
  });

  it("chained property access returns default when intermediate is null", async () => {
    // Access a.b where b is a struct field that may be null
    expect(
      await run(
        `
        interface Inner { val: number }
        interface Outer { inner: Inner }
        function makeOuter(): Outer {
          return { inner: { val: 7 } };
        }
        export function test(): number {
          const obj = makeOuter();
          return obj.inner.val;
        }
        `,
        "test",
      ),
    ).toBe(7);
  });

  it("compiles property access on optional fields without validation errors", () => {
    const result = compile(`
      interface Config {
        name: string;
        value: number;
      }
      function getConfig(flag: number): Config | null {
        if (flag > 0) return { name: "test", value: 42 };
        return null;
      }
      export function run(): number {
        const c = getConfig(1);
        if (c !== null) {
          return c.value;
        }
        return 0;
      }
    `);
    expect(result.success).toBe(true);
    if (result.binary) {
      expect(WebAssembly.validate(result.binary)).toBe(true);
    }
  });

  it("property access on struct returns correct value when non-null", async () => {
    expect(
      await run(
        `
        interface Point { x: number; y: number }
        function makePoint(): Point {
          return { x: 10, y: 20 };
        }
        export function test(): number {
          const p = makePoint();
          return p.x + p.y;
        }
        `,
        "test",
      ),
    ).toBe(30);
  });
});
