import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import type { ImportDescriptor } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

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

describe("closed buildImports", () => {
  it("builds env from manifest with string literals", () => {
    const manifest: ImportDescriptor[] = [
      { module: "env", name: "__str_0", kind: "func", intent: { type: "string_literal", value: "hello" } },
    ];
    const imports = buildImports(manifest);
    expect(imports.env.__str_0()).toBe("hello");
  });

  it("builds env from manifest with Math", () => {
    const manifest: ImportDescriptor[] = [
      { module: "env", name: "Math_floor", kind: "func", intent: { type: "math", method: "floor" } },
    ];
    const imports = buildImports(manifest);
    expect(imports.env.Math_floor(3.7)).toBe(3);
  });

  it("builds env from manifest with extern class get", () => {
    const manifest: ImportDescriptor[] = [
      { module: "env", name: "Foo_get_bar", kind: "func", intent: { type: "extern_class", className: "Foo", action: "get", member: "bar" } },
    ];
    const imports = buildImports(manifest);
    expect(imports.env.Foo_get_bar({ bar: 42 })).toBe(42);
  });

  it("does not include unlisted imports", () => {
    const manifest: ImportDescriptor[] = [
      { module: "env", name: "Math_floor", kind: "func", intent: { type: "math", method: "floor" } },
    ];
    const imports = buildImports(manifest);
    expect(imports.env.Math_ceil).toBeUndefined();
    expect(imports.env.__extern_get).toBeUndefined();
    expect(imports.env.string_constructor).toBeUndefined();
  });

  it("extern class new uses deps", () => {
    class MyWidget { x: number; constructor(x: number) { this.x = x; } }
    const manifest: ImportDescriptor[] = [
      { module: "env", name: "Widget_new", kind: "func", intent: { type: "extern_class", className: "Widget", action: "new" } },
    ];
    const imports = buildImports(manifest, { Widget: MyWidget });
    const w = imports.env.Widget_new(7);
    expect(w).toBeInstanceOf(MyWidget);
    expect((w as any).x).toBe(7);
  });

  it("string methods coerce receiver with String()", () => {
    const manifest: ImportDescriptor[] = [
      { module: "env", name: "string_trim", kind: "func", intent: { type: "string_method", method: "trim" } },
    ];
    const imports = buildImports(manifest);
    expect(imports.env.string_trim("  hi  ")).toBe("hi");
  });
});
