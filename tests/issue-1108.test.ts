import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";

describe("Issue #1108: export default <variable> initialized by call expression", () => {
  it("should export a module global for `export default <variable>` where variable is HOF result", () => {
    const src = `
      function createAdder(defaultValue: number): (a: number, b: number) => number {
        return function(a: number, b: number): number {
          return a + b + defaultValue;
        };
      }
      var add = createAdder(0);
      export default add;
    `;
    const r = compile(src, { fileName: "test.ts" });
    expect(r.success).toBe(true);
    // Check that "default" and "add" are exported in the WAT
    expect(r.wat).toContain('(export "default"');
    expect(r.wat).toContain('(export "add"');
  });

  it("should export a simple call-expression variable as default", () => {
    const src = `
      function identity(x: number): number { return x; }
      function wrap(fn: (x: number) => number): (x: number) => number { return fn; }
      var wrapped = wrap(identity);
      export default wrapped;
    `;
    const r = compile(src, { fileName: "test.ts" });
    expect(r.success).toBe(true);
    expect(r.wat).toContain('(export "default"');
    expect(r.wat).toContain('(export "wrapped"');
  });

  it("should handle var initialized by a literal (not a call) as default export", () => {
    const src = `
      var value: number = 42;
      export default value;
    `;
    const r = compile(src, { fileName: "test.ts" });
    expect(r.success).toBe(true);
    expect(r.wat).toContain('(export "default"');
    expect(r.wat).toContain('(export "value"');
  });

  it("should not duplicate exports when variable is already exported", () => {
    const src = `
      export function createFn(): () => number { return () => 42; }
      var fn = createFn();
      export default fn;
    `;
    const r = compile(src, { fileName: "test.ts" });
    expect(r.success).toBe(true);
    // Count "default" exports — should be exactly 1
    const defaultExports = (r.wat.match(/\(export "default"/g) || []).length;
    expect(defaultExports).toBe(1);
  });
});
