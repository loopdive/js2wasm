import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import type { ImportDescriptor } from "../src/index.js";

describe("ImportDescriptor manifest", () => {
  it("includes string literal imports", () => {
    const result = compile(`
      export function greet(): string { return "hello"; }
    `);
    expect(result.success).toBe(true);
    const strImport = result.imports.find(i => i.name === "__str_0");
    expect(strImport).toBeDefined();
    expect(strImport!.intent).toEqual({ type: "string_literal", value: "hello" });
  });

  it("includes Math imports", () => {
    const result = compile(`
      export function f(x: number): number { return Math.exp(x); }
    `);
    expect(result.success).toBe(true);
    const mathImport = result.imports.find(i => i.name === "Math_exp");
    expect(mathImport).toBeDefined();
    expect(mathImport!.intent).toEqual({ type: "math", method: "exp" });
  });

  it("includes console_log imports", () => {
    const result = compile(`
      export function f(): void { console.log(42); }
    `);
    expect(result.success).toBe(true);
    const logImport = result.imports.find(i => i.name === "console_log_number");
    expect(logImport).toBeDefined();
    expect(logImport!.intent).toEqual({ type: "console_log", variant: "number" });
  });

  it("includes extern class imports", () => {
    const result = compile(`
      declare class Element {
        textContent: string;
        appendChild(child: Element): void;
      }
      export function getText(el: Element): string {
        return el.textContent;
      }
    `);
    expect(result.success).toBe(true);
    const getImport = result.imports.find(i => i.name === "Element_get_textContent");
    expect(getImport).toBeDefined();
    expect(getImport!.intent).toEqual({
      type: "extern_class", className: "Element", action: "get", member: "textContent"
    });
  });

  it("includes string method imports", () => {
    const result = compile(`
      export function f(s: string): string { return s.trim(); }
    `);
    expect(result.success).toBe(true);
    const trimImport = result.imports.find(i => i.name === "string_trim");
    expect(trimImport).toBeDefined();
    expect(trimImport!.intent).toEqual({ type: "string_method", method: "trim" });
  });

  it("includes builtin imports", () => {
    const result = compile(`
      export function f(x: number): string { return x.toString(); }
    `);
    expect(result.success).toBe(true);
    const imp = result.imports.find(i => i.name === "number_toString");
    expect(imp).toBeDefined();
    expect(imp!.intent).toEqual({ type: "builtin", name: "number_toString" });
  });

  it("does not include wasm:js-string module imports in env manifest", () => {
    const result = compile(`
      export function f(): string { return "a" + "b"; }
    `);
    expect(result.success).toBe(true);
    const jsStringImports = result.imports.filter(i => i.module === "wasm:js-string");
    expect(jsStringImports.length).toBe(0);
  });
});
