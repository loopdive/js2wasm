import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(source: string): Promise<Record<string, Function>> {
  const result = compile(source);
  if (!result.success)
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
  return instance.exports as Record<string, Function>;
}

describe("misc CE patterns (#539)", () => {
  describe("String.codePointAt", () => {
    it("compiles codePointAt without errors", () => {
      const result = compile(`
        export function test(): number {
          const s: string = "ABC";
          return s.codePointAt(0);
        }
      `);
      expect(
        result.success,
        `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`,
      ).toBe(true);
    }, 15000);

    it("returns the code point at a given index", async () => {
      const exports = await run(`
        export function test(): number {
          const s: string = "ABC";
          return s.codePointAt(0);
        }
      `);
      expect(exports.test()).toBe(65);
    }, 15000);
  });

  describe("String.normalize", () => {
    it("compiles normalize without errors", () => {
      const result = compile(`
        export function test(): string {
          const s = "hello";
          return s.normalize();
        }
      `);
      expect(
        result.success,
        `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`,
      ).toBe(true);
    });

    it("compiles normalize with form argument", () => {
      const result = compile(`
        export function test(): string {
          const s = "hello";
          return s.normalize("NFC");
        }
      `);
      expect(
        result.success,
        `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`,
      ).toBe(true);
    });
  });

  describe("empty string in template expressions", () => {
    it("compiles template with empty head", () => {
      const result = compile(`
        export function test(): string {
          const x = 42;
          return \`\${x} items\`;
        }
      `);
      expect(
        result.success,
        `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`,
      ).toBe(true);
    });

    it("runs template with empty head correctly", async () => {
      const exports = await run(`
        export function test(): string {
          const x = 42;
          return \`\${x} items\`;
        }
      `);
      expect(exports.test()).toBe("42 items");
    });

    it("compiles template with empty tail", () => {
      const result = compile(`
        export function test(): string {
          const x = "hello";
          return \`prefix \${x}\`;
        }
      `);
      expect(
        result.success,
        `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`,
      ).toBe(true);
    });
  });

  describe("destructuring with unknown type", () => {
    it("compiles destructuring of anonymous object literal", () => {
      const result = compile(`
        function getObj() {
          return { a: 1, b: 2 };
        }
        export function test(): number {
          const { a, b } = getObj();
          return a + b;
        }
      `);
      expect(
        result.success,
        `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`,
      ).toBe(true);
    });
  });
});
