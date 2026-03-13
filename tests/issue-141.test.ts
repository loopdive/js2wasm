import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports, compileToWasm } from "./equivalence/helpers.js";

describe("Issue #141: Tagged template literal runtime failures", () => {
  it("basic tagged template with two substitutions", async () => {
    const e = await compileToWasm(`
      function tag(strings: string[], a: number, b: number): number {
        return strings.length + a + b;
      }
      export function test(): number {
        return tag\`hello \${10} world \${20}\`;
      }
    `);
    // strings has 3 parts: "hello ", " world ", ""
    expect(e.test()).toBe(33);
  });

  it("tagged template with no substitutions", async () => {
    const e = await compileToWasm(`
      function tag(strings: string[]): number {
        return strings.length;
      }
      export function test(): number {
        return tag\`just a string\`;
      }
    `);
    expect(e.test()).toBe(1);
  });

  it("tagged template with rest params collects all substitutions", async () => {
    const e = await compileToWasm(`
      function tag(strings: string[], ...values: number[]): number {
        return strings.length + values.length;
      }
      export function test(): number {
        return tag\`a \${1} b \${2} c \${3} d\`;
      }
    `);
    // strings.length=4, values.length=3 => 7
    expect(e.test()).toBe(7);
  });

  it("tagged template with rest params and zero substitutions", async () => {
    const e = await compileToWasm(`
      function tag(strings: string[], ...values: number[]): number {
        return strings.length + values.length;
      }
      export function test(): number {
        return tag\`no subs\`;
      }
    `);
    // strings.length=1, values.length=0 => 1
    expect(e.test()).toBe(1);
  });

  it("excess substitutions beyond declared params are dropped", async () => {
    const e = await compileToWasm(`
      function tag(strings: string[]): number {
        return strings.length;
      }
      export function test(): number {
        return tag\`a\${1}b\${2}c\`;
      }
    `);
    // tag only accepts strings[], substitutions 1 and 2 are dropped
    // strings.length = 3
    expect(e.test()).toBe(3);
  });

  it("returns substitution value directly", async () => {
    const e = await compileToWasm(`
      function identity(strings: string[], val: number): number {
        return val;
      }
      export function test(): number {
        return identity\`prefix \${99} suffix\`;
      }
    `);
    expect(e.test()).toBe(99);
  });

  it("substitution expressions with variables", async () => {
    const e = await compileToWasm(`
      function sum(strings: string[], a: number, b: number): number {
        return a + b;
      }
      export function test(): number {
        const x = 5;
        const y = 10;
        return sum\`\${x} plus \${y}\`;
      }
    `);
    expect(e.test()).toBe(15);
  });

  it("string content access from first element", async () => {
    const e = await compileToWasm(`
      function first(strings: string[]): string {
        return strings[0];
      }
      export function test(): string {
        return first\`hello world\`;
      }
    `);
    expect(e.test()).toBe("hello world");
  });

  it("string parts count with multiple expressions", async () => {
    const e = await compileToWasm(`
      function tag(strings: string[], a: number, b: number, c: number): number {
        return strings.length;
      }
      export function test(): number {
        return tag\`a\${1}b\${2}c\${3}d\`;
      }
    `);
    expect(e.test()).toBe(4);
  });

  it("empty leading string part when expression comes first", async () => {
    const e = await compileToWasm(`
      function first(strings: string[]): string {
        return strings[0];
      }
      export function test(): string {
        return first\`\${42}trailing\`;
      }
    `);
    // Per spec, when template starts with expression, first string part is ""
    expect(e.test()).toBe("");
  });

  it("concatenating string parts with substitution", async () => {
    const e = await compileToWasm(`
      function tag(strings: string[], a: number): string {
        return strings[0] + String(a) + strings[1];
      }
      export function test(): string {
        return tag\`hello \${42} world\`;
      }
    `);
    expect(e.test()).toBe("hello 42 world");
  });

  it("template object caching does not break repeated calls", async () => {
    const e = await compileToWasm(`
      let callCount: number = 0;

      function tag(strings: string[]): number {
        callCount = callCount + 1;
        return strings.length + callCount;
      }
      export function test(): number {
        const a = tag\`hello\`;
        const b = tag\`hello\`;
        const c = tag\`hello\`;
        return a + b + c;
      }
    `);
    // a = 1+1=2, b = 1+2=3, c = 1+3=4, total = 9
    expect(e.test()).toBe(9);
  });

  it("tagged template called multiple times with different values", async () => {
    const e = await compileToWasm(`
      function tag(strings: string[], val: number): number {
        return val * 2;
      }
      export function test(): number {
        const a = tag\`x\${5}y\`;
        const b = tag\`x\${10}y\`;
        return a + b;
      }
    `);
    // a = 5*2 = 10, b = 10*2 = 20, total = 30
    expect(e.test()).toBe(30);
  });

  it("substitution with arithmetic expression", async () => {
    const e = await compileToWasm(`
      function tag(strings: string[], val: number): number {
        return val;
      }
      export function test(): number {
        return tag\`result: \${3 + 4 * 2}\`;
      }
    `);
    expect(e.test()).toBe(11);
  });

  it("tag function with one param beyond strings accepts first sub only", async () => {
    const e = await compileToWasm(`
      function tag(strings: string[], first: number): number {
        return first;
      }
      export function test(): number {
        return tag\`a\${10}b\${20}c\`;
      }
    `);
    // Only the first substitution (10) is passed; 20 is dropped
    expect(e.test()).toBe(10);
  });
});
