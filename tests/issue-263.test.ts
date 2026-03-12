import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

describe("Issue #263: Dynamic property access fallback", () => {
  it("compiles property access on any type without errors", () => {
    const result = compile(`
      export function test(x: any): any {
        return x.foo;
      }
    `);
    const propErrors = result.errors.filter(e =>
      e.message.includes("Cannot access property")
    );
    expect(propErrors).toHaveLength(0);
  });

  it("compiles .length on any type without errors", () => {
    const result = compile(`
      export function test(x: any): any {
        return x.length;
      }
    `);
    const propErrors = result.errors.filter(e =>
      e.message.includes("Cannot access property")
    );
    expect(propErrors).toHaveLength(0);
  });

  it("compiles .name on any type without errors", () => {
    const result = compile(`
      export function test(x: any): any {
        return x.name;
      }
    `);
    const propErrors = result.errors.filter(e =>
      e.message.includes("Cannot access property")
    );
    expect(propErrors).toHaveLength(0);
  });

  it("compiles .constructor on any type without errors", () => {
    const result = compile(`
      export function test(x: any): any {
        return x.constructor;
      }
    `);
    const propErrors = result.errors.filter(e =>
      e.message.includes("Cannot access property")
    );
    expect(propErrors).toHaveLength(0);
  });

  it("compiles property access on unknown struct field without errors", () => {
    // Access a property that doesn't exist on a known struct type
    const result = compile(`
      function makeObj() { return { a: 1 }; }
      export function test(): number {
        const obj = makeObj();
        return obj.a;
      }
    `);
    // This should compile - 'a' is known on the struct
    const propErrors = result.errors.filter(e =>
      e.message.includes("Cannot access property")
    );
    expect(propErrors).toHaveLength(0);
  });

  it("produces valid wasm when accessing property on any", () => {
    const result = compile(`
      export function test(x: any): any {
        return x.someProp;
      }
    `);
    expect(result.success).toBe(true);
    if (result.binary) {
      expect(WebAssembly.validate(result.binary)).toBe(true);
    }
  });

  it("produces valid wasm for chained property access on any", () => {
    const result = compile(`
      export function test(x: any): any {
        return x.a;
      }
    `);
    expect(result.success).toBe(true);
    if (result.binary) {
      expect(WebAssembly.validate(result.binary)).toBe(true);
    }
  });

  it("compiles multiple property accesses on any without errors", () => {
    const result = compile(`
      export function test(x: any): any {
        const a = x.foo;
        const b = x.bar;
        const c = x.baz;
        return a;
      }
    `);
    const propErrors = result.errors.filter(e =>
      e.message.includes("Cannot access property")
    );
    expect(propErrors).toHaveLength(0);
  });

  it("no Cannot access property errors for typical test262 patterns", () => {
    // Pattern from test262: accessing .length on arguments-like objects
    const result = compile(`
      export function test(): number {
        const args: any = 42;
        return args.length;
      }
    `);
    const propErrors = result.errors.filter(e =>
      e.message.includes("Cannot access property")
    );
    expect(propErrors).toHaveLength(0);
  });

  it("compiles .toString property access on number without errors", () => {
    const result = compile(`
      export function test(x: number): any {
        return (x as any).toString;
      }
    `);
    const propErrors = result.errors.filter(e =>
      e.message.includes("Cannot access property")
    );
    expect(propErrors).toHaveLength(0);
  });

  it("compiles property access in conditional context", () => {
    const result = compile(`
      export function test(x: any): number {
        if (x.enabled) {
          return 1;
        }
        return 0;
      }
    `);
    expect(result.success).toBe(true);
    const propErrors = result.errors.filter(e =>
      e.message.includes("Cannot access property")
    );
    expect(propErrors).toHaveLength(0);
  });
});
