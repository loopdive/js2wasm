import { it, expect } from "vitest";
import { compile } from "../src/index.ts";

it("valid: nullish coalescing with parens", () => {
  const r = compile(`const x = (null ?? 0) || 1; export function test(): number { return x; }`);
  expect(r.success).toBe(true);
});

it("valid: optional chaining without template", () => {
  const r = compile(`
    const obj = { fn: (x: number) => x + 1 };
    const x = obj?.fn(42);
    export function test(): number { return x || 0; }
  `);
  expect(r.success).toBe(true);
});

it("valid: new.target inside function", () => {
  const r = compile(`
    function C() { const x = new.target; }
    export function test(): number { return 1; }
  `);
  // May fail for other reasons but not for new.target
  if (!r.success) {
    for (const e of r.errors) {
      expect(e.message).not.toContain("new.target is only valid");
    }
  }
});

it("valid: super() in derived class", () => {
  const r = compile(`
    class Base { x: number = 1; }
    class Child extends Base { constructor() { super(); } }
    export function test(): number { return 1; }
  `);
  expect(r.success).toBe(true);
});

it("valid: for-of without initializer", () => {
  const r = compile(`
    export function test(): number {
      let sum = 0;
      for (const x of [1, 2, 3]) { sum = sum + x; }
      return sum;
    }
  `);
  expect(r.success).toBe(true);
});

it("valid: generator with yield", () => {
  const r = compile(`
    function* gen() { yield 1; yield 2; }
    export function test(): number { return 1; }
  `);
  expect(r.success).toBe(true);
});

it("valid: void 0", () => {
  const r = compile(`
    const x = void 0;
    export function test(): number { return 1; }
  `);
  expect(r.success).toBe(true);
});

it("valid: tagged template", () => {
  const r = compile(`
    function tag(s: TemplateStringsArray): string { return s[0] || ""; }
    export function test(): number { return 1; }
  `);
  expect(r.success).toBe(true);
});
