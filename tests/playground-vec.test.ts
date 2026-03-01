import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

describe("playground vec patterns", () => {
  it("bench_array with i++ compiles and runs", async () => {
    const src = [
      "export function bench_array(): number {",
      "  const arr: number[] = [];",
      "  for (let i = 0; i < 100; i++) arr.push(i);",
      "  let total = 0;",
      "  for (let i = 0; i < arr.length; i++) total = total + arr[i];",
      "  return total;",
      "}",
    ].join("\n");
    const result = compile(src);
    expect(result.success).toBe(true);
    const { instance } = await WebAssembly.instantiate(result.binary, {
      env: { console_log_number: () => {}, console_log_bool: () => {}, console_log_string: () => {} },
    });
    expect((instance.exports as any).bench_array()).toBe(4950);
  });

  it("DOM + array mix compiles and validates", async () => {
    const src = [
      "let tabEls: HTMLElement[] = [];",
      "",
      "export function bench_dom(): number {",
      "  const host = document.getElementById('preview-panel')!;",
      "  const box = document.createElement('div');",
      "  box.style.cssText = 'display:none';",
      "  host.appendChild(box);",
      "  for (let i = 0; i < 10; i++) {",
      "    const d = document.createElement('span');",
      "    d.textContent = i.toString();",
      "    box.appendChild(d);",
      "  }",
      "  host.removeChild(box);",
      "  return 10;",
      "}",
      "",
      "export function addTab(t: HTMLElement): number {",
      "  tabEls.push(t);",
      "  return tabEls.length;",
      "}",
      "",
      "export function bench_array(): number {",
      "  const arr: number[] = [];",
      "  for (let i = 0; i < 100; i++) arr.push(i);",
      "  let total = 0;",
      "  for (let i = 0; i < arr.length; i++) total = total + arr[i];",
      "  return total;",
      "}",
    ].join("\n");
    const result = compile(src);
    if (!result.success) {
      console.log("Errors:", result.errors);
      console.log("WAT:", result.wat);
    }
    expect(result.success).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);

    // Check WAT for correct struct.new patterns
    const wat = result.wat;
    expect(wat).toContain("struct.new");
    expect(wat).toContain("array.copy");
  });

  it("local number array literal in function", async () => {
    const src = [
      "export function fdow(): number {",
      "  const t = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];",
      "  return t[3];",
      "}",
    ].join("\n");
    const result = compile(src);
    expect(result.success).toBe(true);
    const { instance } = await WebAssembly.instantiate(result.binary, {
      env: { console_log_number: () => {}, console_log_bool: () => {}, console_log_string: () => {} },
    });
    expect((instance.exports as any).fdow()).toBe(5);
  });

  it("string array literal access", async () => {
    const src = [
      "export function test(): string {",
      '  const days = ["MON", "TUE", "WED"];',
      "  return days[1];",
      "}",
    ].join("\n");
    const result = compile(src);
    if (!result.success) {
      console.log("Errors:", result.errors);
      console.log("WAT:", result.wat);
    }
    expect(result.success).toBe(true);

    const env: Record<string, Function> = {
      console_log_number: () => {},
      console_log_bool: () => {},
      console_log_string: () => {},
    };
    for (let i = 0; i < result.stringPool.length; i++) {
      const val = result.stringPool[i]!;
      env["__str_" + i] = () => val;
    }
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
    } as WebAssembly.Imports);
    expect((instance.exports as any).test()).toBe("TUE");
  });
});
