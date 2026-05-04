import { describe, it, expect } from "vitest";
import { compileMulti } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function instantiateMulti(files: Record<string, string>, entry: string, opts: any = { allowJs: true }) {
  const r = compileMulti(files, entry, opts);
  expect(r.success, `Compile failed:\n${r.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`).toBe(true);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  return instance.exports as Record<string, any>;
}

describe("#1109 — multi-file module init order", () => {
  // Regression: in a chain a → b → c, c's top-level statements must run before
  // b's, and b's before a's. Previously the compiler concatenated init code in
  // entry-first DFS order, so `var a = b * 10` ran before `var b = c + 1`,
  // leaving b at its f64 default (0).
  it("init order respects import dependencies in a chain", async () => {
    const files = {
      "./entry.js": `import a from "./a.js"; export function run(): number { return a; }`,
      "./a.js": `import b from "./b.js"; var a = b * 10; export default a;`,
      "./b.js": `import c from "./c.js"; var b = c + 1; export default b;`,
      "./c.js": `var c = 42; export default c;`,
    };
    const e = await instantiateMulti(files, "./entry.js");
    expect(e.run()).toBe(430);
  });

  // The same chain expressed entry-last (already topological) — must still work.
  it("init order works when input is already topological", async () => {
    const files = {
      "./c.js": `var c = 42; export default c;`,
      "./b.js": `import c from "./c.js"; var b = c + 1; export default b;`,
      "./a.js": `import b from "./b.js"; var a = b * 10; export default a;`,
      "./entry.js": `import a from "./a.js"; export function run(): number { return a; }`,
    };
    const e = await instantiateMulti(files, "./entry.js");
    expect(e.run()).toBe(430);
  });

  // Cycles are tolerated — first-seen wins. The result mirrors ES module
  // evaluation order semantics (one module's body completes before the next
  // module that depends on it, with cycles broken by hoisting).
  it("does not stack-overflow on import cycles", async () => {
    const files = {
      "./a.js": `import { fromB } from "./b.js"; export function fromA() { return 1; } export { fromB };`,
      "./b.js": `import { fromA } from "./a.js"; export function fromB() { return 2; } export { fromA };`,
      "./entry.js": `import { fromA, fromB } from "./a.js"; export function run() { return fromA() + fromB(); }`,
    };
    const e = await instantiateMulti(files, "./entry.js");
    expect(e.run()).toBe(3);
  });
});
