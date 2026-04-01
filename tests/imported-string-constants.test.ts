import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildStringConstants } from "../src/runtime.js";

/**
 * Helper: compile TS source and instantiate with string_constants + polyfill.
 * Returns the Wasm instance exports.
 */
async function run(source: string, fn: string, args: unknown[] = []): Promise<unknown> {
  const result = compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }

  const env: Record<string, Function> = {
    console_log_number: () => {},
    console_log_bool: () => {},
    console_log_string: () => {},
    number_toString: (v: number) => String(v),
  };

  const jsStringPolyfill = {
    concat: (a: string, b: string) => a + b,
    length: (s: string) => s.length,
    equals: (a: string, b: string) => (a === b ? 1 : 0),
    substring: (s: string, start: number, end: number) => s.substring(start, end),
    charCodeAt: (s: string, i: number) => s.charCodeAt(i),
  };

  const { instance } = await WebAssembly.instantiate(result.binary, {
    env,
    "wasm:js-string": jsStringPolyfill,
    string_constants: buildStringConstants(result.stringPool),
  } as WebAssembly.Imports);
  return (instance.exports as any)[fn](...args);
}

describe("importedStringConstants", () => {
  describe("WAT output structure", () => {
    it("string literals become global imports from string_constants namespace", () => {
      const result = compile(`
        export function hello(): string {
          return "world";
        }
      `);
      expect(result.success).toBe(true);

      // WAT should contain string_constants import, not env import for strings
      expect(result.wat).toContain('(import "string_constants"');
      expect(result.wat).toContain("(global");
      // Should NOT contain __str_ function imports in env
      expect(result.wat).not.toMatch(/\(import "env" "__str_\d+"/);
      // Should use global.get, not call for string literal access
      expect(result.wat).toContain("global.get");
    });

    it("multiple distinct string literals produce multiple global imports", () => {
      const result = compile(`
        export function test(): string {
          const a = "foo";
          const b = "bar";
          const c = "baz";
          return a;
        }
      `);
      expect(result.success).toBe(true);
      expect(result.stringPool).toContain("foo");
      expect(result.stringPool).toContain("bar");
      expect(result.stringPool).toContain("baz");
      expect(result.stringPool.length).toBe(3);
    });

    it("duplicate string literals share the same global import", () => {
      const result = compile(`
        export function test(): string {
          const a = "hello";
          const b = "hello";
          return a;
        }
      `);
      expect(result.success).toBe(true);
      // Should only have one entry for "hello"
      expect(result.stringPool.filter((s: string) => s === "hello").length).toBe(1);
    });

    it("no string_constants section when source has no string literals", () => {
      const result = compile(`
        export function add(a: number, b: number): number {
          return a + b;
        }
      `);
      expect(result.success).toBe(true);
      expect(result.stringPool.length).toBe(0);
      // WAT should not mention string_constants
      expect(result.wat).not.toContain("string_constants");
    });
  });

  describe("string pool", () => {
    it("stringPool contains all unique string literals", () => {
      const result = compile(`
        export function test(): string {
          const x = "alpha";
          const y = "beta";
          return x;
        }
      `);
      expect(result.success).toBe(true);
      expect(result.stringPool).toEqual(expect.arrayContaining(["alpha", "beta"]));
    });

    it("stringPool contains template literal parts", () => {
      const result = compile(`
        export function greet(name: string): string {
          return "Hello, " + name + "!";
        }
      `);
      expect(result.success).toBe(true);
      expect(result.stringPool).toContain("Hello, ");
      expect(result.stringPool).toContain("!");
    });

    it("stringPool contains string enum values", () => {
      const result = compile(`
        enum Color { Red = "RED", Green = "GREEN", Blue = "BLUE" }
        export function test(): string {
          return Color.Red;
        }
      `);
      expect(result.success).toBe(true);
      expect(result.stringPool).toContain("RED");
      expect(result.stringPool).toContain("GREEN");
      expect(result.stringPool).toContain("BLUE");
    });
  });

  describe("buildStringConstants", () => {
    it("creates WebAssembly.Global objects from string pool", () => {
      const constants = buildStringConstants(["hello", "world"]);
      expect(constants.__str_0).toBeInstanceOf(WebAssembly.Global);
      expect(constants.__str_1).toBeInstanceOf(WebAssembly.Global);
      expect(constants.__str_0.value).toBe("hello");
      expect(constants.__str_1.value).toBe("world");
    });

    it("preserves pool order even for duplicate strings", () => {
      const constants = buildStringConstants(["a", "b", "a"]);
      expect(Object.keys(constants)).toEqual(["__str_0", "__str_1", "__str_2"]);
      expect(constants.__str_0.value).toBe("a");
      expect(constants.__str_1.value).toBe("b");
      expect(constants.__str_2.value).toBe("a");
    });

    it("handles empty string pool", () => {
      const constants = buildStringConstants([]);
      expect(Object.keys(constants).length).toBe(0);
    });

    it("handles empty string values", () => {
      const constants = buildStringConstants([""]);
      expect(constants.__str_0).toBeInstanceOf(WebAssembly.Global);
      expect(constants.__str_0.value).toBe("");
    });

    it("handles special characters in strings", () => {
      const constants = buildStringConstants(["hello\nworld", "tab\there", 'quotes"inside']);
      expect(constants.__str_0.value).toBe("hello\nworld");
      expect(constants.__str_1.value).toBe("tab\there");
      expect(constants.__str_2.value).toBe('quotes"inside');
    });
  });

  describe("end-to-end execution", () => {
    it("returns a string literal", async () => {
      expect(await run(`export function hello(): string { return "world"; }`, "hello")).toBe("world");
    });

    it("compares string with literal using ===", async () => {
      const src = `
        export function check(s: string): boolean {
          return s === "expected";
        }
      `;
      expect(await run(src, "check", ["expected"])).toBe(1);
      expect(await run(src, "check", ["other"])).toBe(0);
    });

    it("concatenates string literal with parameter", async () => {
      expect(
        await run(
          `
          export function greet(name: string): string {
            return "Hello, " + name;
          }
        `,
          "greet",
          ["Alice"],
        ),
      ).toBe("Hello, Alice");
    });

    it("multiple string literals in one function", async () => {
      expect(
        await run(
          `
          export function classify(n: number): string {
            if (n < 0) return "negative";
            if (n === 0) return "zero";
            return "positive";
          }
        `,
          "classify",
          [0],
        ),
      ).toBe("zero");
    });

    it("string enum value is accessible at runtime", async () => {
      expect(
        await run(
          `
          enum Dir { Up = "UP", Down = "DOWN" }
          export function test(): string {
            return Dir.Down;
          }
        `,
          "test",
        ),
      ).toBe("DOWN");
    });

    it("string array literal access works", async () => {
      expect(
        await run(
          `
          export function test(): string {
            const days = ["MON", "TUE", "WED"];
            return days[1];
          }
        `,
          "test",
        ),
      ).toBe("TUE");
    });

    it("binary validates with WebAssembly.validate", () => {
      const result = compile(`
        export function test(): string {
          return "hello";
        }
      `);
      expect(result.success).toBe(true);
      expect(WebAssembly.validate(result.binary)).toBe(true);
    });

    it("module with no strings needs no string_constants import", async () => {
      const result = compile(`
        export function add(a: number, b: number): number {
          return a + b;
        }
      `);
      expect(result.success).toBe(true);
      // Should instantiate fine without string_constants
      const { instance } = await WebAssembly.instantiate(result.binary, {
        env: {},
      });
      expect((instance.exports as any).add(2, 3)).toBe(5);
    });

    it("module globals coexist with string constant globals", async () => {
      const src = `
        let counter = 0;
        export function increment(): number {
          counter = counter + 1;
          return counter;
        }
        export function label(): string {
          return "count";
        }
      `;
      const result = compile(src);
      expect(result.success).toBe(true);

      const env: Record<string, Function> = {
        console_log_number: () => {},
        console_log_bool: () => {},
        console_log_string: () => {},
      };
      const jsStringPolyfill = {
        concat: (a: string, b: string) => a + b,
        length: (s: string) => s.length,
        equals: (a: string, b: string) => (a === b ? 1 : 0),
        substring: (s: string, start: number, end: number) => s.substring(start, end),
        charCodeAt: (s: string, i: number) => s.charCodeAt(i),
      };

      const { instance } = await WebAssembly.instantiate(result.binary, {
        env,
        "wasm:js-string": jsStringPolyfill,
        string_constants: buildStringConstants(result.stringPool),
      } as WebAssembly.Imports);
      const exports = instance.exports as any;

      // Module globals work
      expect(exports.increment()).toBe(1);
      expect(exports.increment()).toBe(2);
      // String constant works
      expect(exports.label()).toBe("count");
    });
  });
});
