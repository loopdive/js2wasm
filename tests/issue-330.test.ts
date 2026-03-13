import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

function compileAndRun(code: string) {
  const result = compile(code);
  if (!result.success) {
    throw new Error(`Compilation failed: ${result.errors.map(e => e.message).join(", ")}`);
  }
  const mod = new WebAssembly.Module(result.binary);
  const inst = new WebAssembly.Instance(mod, buildImports(result.imports, undefined, result.stringPool));
  return inst;
}

describe("Issue #330: ClassExpression in unsupported positions", () => {
  it("class expression in variable declaration (baseline)", () => {
    const inst = compileAndRun(`
      const C = class {
        x: number;
        constructor() { this.x = 42; }
        getX(): number { return this.x; }
      };
      const obj = new C();
      export function test(): number { return obj.getX(); }
    `);
    const test = (inst.exports as any).test;
    expect(test()).toBe(42);
  });

  it("class expression in assignment RHS compiles without error", () => {
    const result = compile(`
      let C: any;
      C = class {
        x: number;
        constructor() { this.x = 99; }
        getX(): number { return this.x; }
      };
      export function test(): number { return 1; }
    `);
    // The class expression should not produce an "Unsupported expression" error
    const classExprErrors = result.errors.filter(e => e.message.includes("ClassExpression"));
    expect(classExprErrors).toHaveLength(0);
  });

  it("named class expression in assignment compiles without error", () => {
    const result = compile(`
      let C: any;
      C = class MyClass {
        value: number;
        constructor() { this.value = 77; }
        getValue(): number { return this.value; }
      };
      export function test(): number { return 1; }
    `);
    const classExprErrors = result.errors.filter(e => e.message.includes("ClassExpression"));
    expect(classExprErrors).toHaveLength(0);
  });

  it("class expression compiles without error", () => {
    const result = compile(`
      let cls: any;
      cls = class {};
      export function test(): number { return 1; }
    `);
    const classExprErrors = result.errors.filter(e => e.message.includes("ClassExpression"));
    expect(classExprErrors).toHaveLength(0);
  });

  it("class expression with new on same line", () => {
    const inst = compileAndRun(`
      const obj = new (class {
        x: number;
        constructor() { this.x = 55; }
        getX(): number { return this.x; }
      })();
      export function test(): number { return obj.getX(); }
    `);
    const test = (inst.exports as any).test;
    expect(test()).toBe(55);
  });
});
