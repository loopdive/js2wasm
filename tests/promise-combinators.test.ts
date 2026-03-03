import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

describe("Promise.all / Promise.race", () => {
  it("Promise.all with resolved values", async () => {
    // Use Promise<any> return type so the unwrapped type is 'any' → externref
    const result = compile(`
      declare namespace Host {
        class Source {
          constructor();
          getPromises(): Promise<number>[];
        }
      }
      export async function runAll(): Promise<any> {
        const src = new Host.Source();
        return await Promise.all(src.getPromises());
      }
    `);
    expect(
      result.success,
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    ).toBe(true);

    class MockSource {
      getPromises() { return [Promise.resolve(1), Promise.resolve(2), Promise.resolve(3)]; }
    }
    const imports = buildImports(result.imports, { Source: MockSource }, result.stringPool);
    const { instance } = await WebAssembly.instantiate(
      result.binary,
      imports as WebAssembly.Imports,
    );
    const exports = instance.exports as any;
    // The Wasm function returns an externref (the Promise from Promise.all);
    // await from JS resolves it
    const out = await exports.runAll();
    expect(out).toEqual([1, 2, 3]);
  });

  it("Promise.race with resolved values", async () => {
    const result = compile(`
      declare namespace Host {
        class Source {
          constructor();
          getPromises(): Promise<number>[];
        }
      }
      export async function runRace(): Promise<any> {
        const src = new Host.Source();
        return await Promise.race(src.getPromises());
      }
    `);
    expect(
      result.success,
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    ).toBe(true);

    class MockSource {
      getPromises() { return [Promise.resolve(10), Promise.resolve(20), Promise.resolve(30)]; }
    }
    const imports = buildImports(result.imports, { Source: MockSource }, result.stringPool);
    const { instance } = await WebAssembly.instantiate(
      result.binary,
      imports as WebAssembly.Imports,
    );
    const exports = instance.exports as any;
    const out = await exports.runRace();
    expect(out).toBe(10);
  });

  it("Promise.all compiles correctly (compilation check)", () => {
    const result = compile(`
      declare function getArr(): Promise<number>[];
      export async function allNums(): Promise<any> {
        const a = getArr();
        return await Promise.all(a);
      }
    `);
    expect(
      result.success,
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    ).toBe(true);
    expect(result.wat).toContain("Promise_all");
  });

  it("Promise.race compiles correctly (compilation check)", () => {
    const result = compile(`
      declare function getArr(): Promise<number>[];
      export async function raceNums(): Promise<any> {
        const a = getArr();
        return await Promise.race(a);
      }
    `);
    expect(
      result.success,
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    ).toBe(true);
    expect(result.wat).toContain("Promise_race");
  });
});
