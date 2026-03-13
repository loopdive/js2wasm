import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

describe("Issue #307: Promise.all and Promise.race compile errors", () => {
  it("Promise.resolve compiles", () => {
    const result = compile(`
      export function test(): any {
        return Promise.resolve(42);
      }
    `);
    expect(
      result.success,
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    ).toBe(true);
  });

  it("Promise.reject compiles", () => {
    const result = compile(`
      export function test(): any {
        return Promise.reject("err");
      }
    `);
    expect(
      result.success,
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    ).toBe(true);
  });

  it("Promise.resolve() with no args compiles", () => {
    const result = compile(`
      export function test(): any {
        return Promise.resolve();
      }
    `);
    expect(
      result.success,
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    ).toBe(true);
  });

  it("Promise.all with array literal compiles", () => {
    const result = compile(`
      export async function test(): Promise<any> {
        return await Promise.all([Promise.resolve(1), Promise.resolve(2)]);
      }
    `);
    expect(
      result.success,
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    ).toBe(true);
  });

  it("Promise.race with array literal compiles", () => {
    const result = compile(`
      export async function test(): Promise<any> {
        return await Promise.race([Promise.resolve(1), Promise.resolve(2)]);
      }
    `);
    expect(
      result.success,
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    ).toBe(true);
  });

  it("new Promise compiles", () => {
    const result = compile(`
      export function test(): any {
        return new Promise((resolve, reject) => {
          resolve(42);
        });
      }
    `);
    expect(
      result.success,
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    ).toBe(true);
  });

  it("Promise.all with spread argument compiles", () => {
    const result = compile(`
      declare function getPromises(): Promise<number>[];
      export async function test(): Promise<any> {
        return await Promise.all(getPromises());
      }
    `);
    expect(
      result.success,
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    ).toBe(true);
  });
});
