import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { parseMeta, wrapTest } from "./test262-runner.js";

async function runWrapped(body: string): Promise<number> {
  const meta = parseMeta(body);
  const { source } = wrapTest(body, meta);
  const r = compile(source, { fileName: "test.ts" });
  if (!r.success) throw new Error("CE: " + r.errors[0]?.message);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports as any);
  if (typeof (imports as any).setExports === "function") {
    (imports as any).setExports(instance.exports);
  }
  return (instance.exports as any).test();
}

describe("#1049 destructuring default init NamedEvaluation (fn-name-cover)", () => {
  it("array destructuring: direct anon fn gets binding name; comma-covered fn does not", async () => {
    const v = await runWrapped(`
      var [cover = (function () {}), xCover = (0, function() {})] = [];
      assert.sameValue(cover.name, 'cover');
      assert.notSameValue(xCover.name, 'xCover');
    `);
    expect(v).toBe(1);
  });

  it("object destructuring: same rule — direct anon fn covered comma excluded", async () => {
    const v = await runWrapped(`
      var { a = (function () {}), b = (0, function() {}) } = {};
      assert.sameValue(a.name, 'a');
      assert.notSameValue(b.name, 'b');
    `);
    expect(v).toBe(1);
  });
});
