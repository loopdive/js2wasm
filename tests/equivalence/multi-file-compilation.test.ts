import { describe, it, expect } from "vitest";
import { compileMulti, compileFiles } from "../../src/index.js";
import { buildImports } from "./helpers.js";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Compile multiple virtual files and run the entry file's exports.
 */
async function compileAndRunMulti(files: Record<string, string>, entryFile: string) {
  const result = compileMulti(files, entryFile);
  expect(
    result.success,
    `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
  ).toBe(true);
  const imports = buildImports(result);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return instance.exports as Record<string, Function>;
}

describe("multi-file compilation", () => {
  it("a.ts exports function, b.ts imports and calls it", async () => {
    const files = {
      "./a.ts": `
        export function add(a: number, b: number): number {
          return a + b;
        }
      `,
      "./b.ts": `
        import { add } from "./a";
        export function run(x: number, y: number): number {
          return add(x, y);
        }
      `,
    };
    const e = await compileAndRunMulti(files, "./b.ts");
    expect(e.run(3, 7)).toBe(10);
  });

  it("exported helper function used across files", async () => {
    const files = {
      "./constants.ts": `
        export function getFactor(): number {
          return 10;
        }
        export function scale(x: number): number {
          return x * getFactor();
        }
      `,
      "./main.ts": `
        import { scale } from "./constants";
        export function run(x: number): number {
          return scale(x);
        }
      `,
    };
    const e = await compileAndRunMulti(files, "./main.ts");
    expect(e.run(5)).toBe(50);
  });

  it("three-file chain: main -> util -> helper", async () => {
    const files = {
      "./helper.ts": `
        export function double(x: number): number {
          return x * 2;
        }
      `,
      "./util.ts": `
        import { double } from "./helper";
        export function quadruple(x: number): number {
          return double(double(x));
        }
      `,
      "./main.ts": `
        import { quadruple } from "./util";
        export function run(x: number): number {
          return quadruple(x);
        }
      `,
    };
    const e = await compileAndRunMulti(files, "./main.ts");
    expect(e.run(3)).toBe(12);
  });

  it("only entry file exports are Wasm exports", async () => {
    const files = {
      "./lib.ts": `
        export function secret(): number {
          return 42;
        }
      `,
      "./main.ts": `
        import { secret } from "./lib";
        export function run(): number {
          return secret();
        }
      `,
    };
    const e = await compileAndRunMulti(files, "./main.ts");
    expect(e.run()).toBe(42);
    // secret should NOT be a Wasm export
    expect(e.secret).toBeUndefined();
  });
});

describe("compileFiles (disk-based)", () => {
  const tmpDir = join(tmpdir(), `js2wasm-test-${Date.now()}`);

  // Create temp files before tests
  it("resolves imports from disk via ts.createProgram", async () => {
    mkdirSync(tmpDir, { recursive: true });
    try {
      writeFileSync(
        join(tmpDir, "math.ts"),
        `export function multiply(a: number, b: number): number {
          return a * b;
        }`,
      );
      writeFileSync(
        join(tmpDir, "main.ts"),
        `import { multiply } from "./math";
        export function run(a: number, b: number): number {
          return multiply(a, b);
        }`,
      );

      const result = compileFiles(join(tmpDir, "main.ts"));
      expect(
        result.success,
        `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`,
      ).toBe(true);
      const imports = buildImports(result);
      const { instance } = await WebAssembly.instantiate(result.binary, imports);
      const exports = instance.exports as Record<string, Function>;
      expect(exports.run(6, 7)).toBe(42);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
