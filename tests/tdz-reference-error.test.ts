import { describe, test, expect } from "vitest";
import { compile } from "../src/index.js";

describe("Temporal Dead Zone (TDZ) detection (#428)", () => {
  test("let: use before declaration in prior statement", () => {
    const result = compile("x; let x;", { allowJs: true });
    expect(result.success).toBe(false);
    expect(result.errors.some(e => e.severity === "error" && e.message.includes("before initialization"))).toBe(true);
  });

  test("let: self-reference in initializer", () => {
    const result = compile("let x = x + 1;", { allowJs: true });
    expect(result.success).toBe(false);
    expect(result.errors.some(e => e.severity === "error" && e.message.includes("before initialization"))).toBe(true);
  });

  test("const: use before declaration in prior statement", () => {
    const result = compile("x; const x = 1;", { allowJs: true });
    expect(result.success).toBe(false);
    expect(result.errors.some(e => e.severity === "error" && e.message.includes("before initialization"))).toBe(true);
  });

  test("const: self-reference in initializer", () => {
    const result = compile("const x = x + 1;", { allowJs: true });
    expect(result.success).toBe(false);
    expect(result.errors.some(e => e.severity === "error" && e.message.includes("before initialization"))).toBe(true);
  });

  test("var: hoisting is valid (no TDZ)", () => {
    const result = compile("x = 1; var x = 2; export function f(): number { return x; }");
    expect(result.success).toBe(true);
  });

  test("let: reference inside nested function is valid (not direct TDZ)", () => {
    const result = compile("function f() { return x; } let x = 5; export function g(): number { return f(); }");
    expect(result.success).toBe(true);
  });

  test("let: normal usage after declaration is valid", () => {
    const result = compile("let x = 5; const y = x + 1; export function f(): number { return y; }");
    expect(result.success).toBe(true);
  });

  test("TDZ in block scope", () => {
    const result = compile("export function f(): number { { x; let x = 1; } return 0; }");
    expect(result.success).toBe(false);
    expect(result.errors.some(e => e.severity === "error" && e.message.includes("before initialization"))).toBe(true);
  });

  test("assignment to let before declaration", () => {
    const result = compile("x = 1; let x;", { allowJs: true });
    expect(result.success).toBe(false);
    expect(result.errors.some(e => e.severity === "error")).toBe(true);
  });
});
