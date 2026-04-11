import { describe, it, expect } from "vitest";
import { compileMulti } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

// Issue #1061: analyzeMultiSource must accept { allowJs } and propagate to
// ts.createProgram; normalizeFileName must preserve .js/.mjs/.cjs extensions;
// the compiler host must pick ts.ScriptKind.JS for those entries.

describe("issue #1061: multi-source allowJs", () => {
  it("compiles a .ts entry that imports a .js helper", async () => {
    const files = {
      "./add.js": `
        export function add(a, b) { return a + b; }
      `,
      "./main.ts": `
        import { add } from "./add.js";
        export function run(a: number, b: number): number {
          return add(a, b);
        }
      `,
    };

    const result = compileMulti(files, "./main.ts", { allowJs: true });
    expect(
      result.success,
      `Compile failed: ${result.errors.map((e) => `${e.message} @ ${e.line}:${e.column}`).join("; ")}`,
    ).toBe(true);

    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    const exports = instance.exports as Record<string, Function>;
    expect(exports.run(2, 3)).toBe(5);
  });

  it("compiles a .ts entry that imports a .js helper via extensionless specifier", async () => {
    const files = {
      "./util.js": `
        export function sub(a, b) { return a - b; }
      `,
      "./main.ts": `
        import { sub } from "./util";
        export function run(a: number, b: number): number {
          return sub(a, b);
        }
      `,
    };

    const result = compileMulti(files, "./main.ts", { allowJs: true });
    expect(
      result.success,
      `Compile failed: ${result.errors.map((e) => `${e.message} @ ${e.line}:${e.column}`).join("; ")}`,
    ).toBe(true);

    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    const exports = instance.exports as Record<string, Function>;
    expect(exports.run(10, 4)).toBe(6);
  });

  it("compiles a .js entry with a .js helper (pure JS multi-file)", async () => {
    const files = {
      "./lib.js": `
        export function mul(a, b) { return a * b; }
      `,
      "./main.js": `
        import { mul } from "./lib.js";
        export function run(a, b) { return mul(a, b); }
      `,
    };

    const result = compileMulti(files, "./main.js", { allowJs: true });
    expect(
      result.success,
      `Compile failed: ${result.errors.map((e) => `${e.message} @ ${e.line}:${e.column}`).join("; ")}`,
    ).toBe(true);

    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    const exports = instance.exports as Record<string, Function>;
    expect(exports.run(6, 7)).toBe(42);
  });
});
