import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

describe("safe mode", () => {
  describe("clean code passes", () => {
    it("pure compute code compiles in safe mode", () => {
      const result = compile(
        `export function add(a: number, b: number): number { return a + b; }`,
        { safe: true },
      );
      expect(result.success).toBe(true);
    });

    it("string operations compile in safe mode", () => {
      const result = compile(
        `export function greet(name: string): string { return "hello " + name; }`,
        { safe: true },
      );
      expect(result.success).toBe(true);
    });

    it("Math functions compile in safe mode", () => {
      const result = compile(
        `export function area(r: number): number { return Math.PI * r * r; }`,
        { safe: true },
      );
      expect(result.success).toBe(true);
    });
  });

  describe("declare const globals", () => {
    it("rejects undeclared globals", () => {
      const result = compile(
        `declare const document: any;\nexport function test(): number { return 1; }`,
        { safe: true },
      );
      expect(result.success).toBe(false);
      expect(result.errors.some(e => e.message.includes("declared global") && e.message.includes("document"))).toBe(true);
    });

    it("allows explicitly allowlisted globals", () => {
      const result = compile(
        `declare class Document { createElement(tag: string): number; }\ndeclare const document: Document;\nexport function test(): number { return 1; }`,
        { safe: true, allowedGlobals: ["document"] },
      );
      expect(result.success).toBe(true);
    });

    it("rejects any type on declared globals", () => {
      const result = compile(
        `declare const myGlobal: any;\nexport function test(): number { return 1; }`,
        { safe: true, allowedGlobals: ["myGlobal"] },
      );
      expect(result.success).toBe(false);
      expect(result.errors.some(e => e.message.includes('"any" type'))).toBe(true);
    });
  });

  describe("extern class members", () => {
    it("rejects __proto__ on extern classes", () => {
      const result = compile(
        `declare class MyObj { __proto__: number; }\nexport function test(): number { return 1; }`,
        { safe: true },
      );
      expect(result.success).toBe(false);
      expect(result.errors.some(e => e.message.includes("__proto__") && e.message.includes("blocked"))).toBe(true);
    });

    it("rejects innerHTML on extern classes", () => {
      const result = compile(
        `declare class Element { innerHTML: string; }\nexport function test(): number { return 1; }`,
        { safe: true },
      );
      expect(result.success).toBe(false);
      expect(result.errors.some(e => e.message.includes("innerHTML"))).toBe(true);
    });

    it("allows members in the allowlist", () => {
      const result = compile(
        `declare class Element { textContent: string; }\ndeclare const el: Element;\nexport function test(): string { return el.textContent; }`,
        { safe: true, allowedGlobals: ["el"], allowedExternMembers: { Element: ["textContent"] } },
      );
      expect(result.success).toBe(true);
    });

    it("rejects members not in the allowlist when allowlist is provided", () => {
      const result = compile(
        `declare class Element { textContent: string; className: string; }\nexport function test(): number { return 1; }`,
        { safe: true, allowedExternMembers: { Element: ["textContent"] } },
      );
      expect(result.success).toBe(false);
      expect(result.errors.some(e => e.message.includes("className") && e.message.includes("not in allowedExternMembers"))).toBe(true);
    });

    it("rejects any type on extern class members", () => {
      const result = compile(
        `declare class MyObj { data: any; }\nexport function test(): number { return 1; }`,
        { safe: true },
      );
      expect(result.success).toBe(false);
      expect(result.errors.some(e => e.message.includes('"any" type') && e.message.includes("MyObj.data"))).toBe(true);
    });
  });

  describe("dynamic property access", () => {
    it("rejects dynamic property access on extern classes", () => {
      const result = compile(
        `declare class Collection { length: number; }\ndeclare const c: Collection;\nexport function test(i: number): number { return c[i]; }`,
        { safe: true, allowedGlobals: ["c"], allowedExternMembers: { Collection: ["length"] } },
      );
      expect(result.success).toBe(false);
      expect(result.errors.some(e => e.message.includes("dynamic property access"))).toBe(true);
    });
  });

  describe("error locations", () => {
    it("errors include line and column numbers", () => {
      const result = compile(
        `// line 1\n// line 2\ndeclare const bad: any;\nexport function test(): number { return 1; }`,
        { safe: true },
      );
      expect(result.success).toBe(false);
      const err = result.errors.find(e => e.message.includes("declared global"));
      expect(err).toBeDefined();
      expect(err!.line).toBe(3);
      expect(err!.column).toBeGreaterThan(0);
    });
  });

  describe("non-safe mode unaffected", () => {
    it("dangerous patterns compile without safe mode", () => {
      const result = compile(
        `declare const document: any;\ndeclare class Element { innerHTML: string; __proto__: number; }\nexport function test(): number { return 1; }`,
      );
      // Should compile (may have type errors but not safe mode errors)
      expect(result.errors.every(e => !e.message.includes("Safe mode"))).toBe(true);
    });
  });
});
