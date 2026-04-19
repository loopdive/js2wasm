import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

async function run(code: string, opts?: { allowJs?: boolean; fileName?: string }) {
  const r = compile(code, { fileName: opts?.fileName ?? "test.ts", allowJs: opts?.allowJs });
  if (!r.success) throw new Error(`CE: ${r.errors[0]?.message}`);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  return { instance, wat: r.wat };
}

describe("#1074 — export default as Wasm function export", () => {
  it("export default <identifier> emits both named and default exports", async () => {
    const { instance } = await run(`
      function identity(value: number): number { return value; }
      export default identity;
    `);
    const exports = instance.exports as any;
    expect(typeof exports.identity).toBe("function");
    expect(typeof exports.default).toBe("function");
    expect(exports.identity(42)).toBe(42);
    expect(exports.default(42)).toBe(42);
  });

  it("export default function foo() {} emits both named and default exports", async () => {
    const { instance } = await run(`
      export default function double(x: number): number { return x * 2; }
    `);
    const exports = instance.exports as any;
    expect(typeof exports.double).toBe("function");
    expect(typeof exports.default).toBe("function");
    expect(exports.double(5)).toBe(10);
    expect(exports.default(5)).toBe(10);
  });

  it("anonymous export default function emits default export", async () => {
    const { instance } = await run(`
      export default function(x: number): number { return x * 2; }
    `);
    const exports = instance.exports as any;
    expect(typeof exports.default).toBe("function");
    expect(exports.default(7)).toBe(14);
  });

  it("export default with allowJs (lodash-es pattern)", async () => {
    const { instance } = await run(`function identity(value) { return value; }\nexport default identity;\n`, {
      allowJs: true,
      fileName: "identity.js",
    });
    const exports = instance.exports as any;
    expect(typeof exports.identity).toBe("function");
    expect(typeof exports.default).toBe("function");
    expect(exports.identity(42)).toBe(42);
    expect(exports.default(42)).toBe(42);
  });

  it("named exports still work alongside export default", async () => {
    const { instance } = await run(`
      export function add(a: number, b: number): number { return a + b; }
      function mul(a: number, b: number): number { return a * b; }
      export default mul;
    `);
    const exports = instance.exports as any;
    expect(exports.add(2, 3)).toBe(5);
    expect(exports.mul(2, 3)).toBe(6);
    expect(exports.default(2, 3)).toBe(6);
  });
});
