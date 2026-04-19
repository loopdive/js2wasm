import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

async function compileAndInstantiate(source: string) {
  const r = compile(source, { fileName: "test.ts" });
  if (!r.success) throw new Error("compile error: " + r.errors[0]?.message);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  return instance.exports as any;
}

describe("__argc global index staleness (regression for #189 narrowing)", () => {
  it("module-scope let decls preceding a call to a function that reads `arguments` do not corrupt __argc", async () => {
    // Minimal repro of test262 S11.2.4_A1.1_T1.js failure mode.
    // ensureArgcGlobal() captures argcGlobalIdx as the absolute Wasm global index
    // at registration time. Late string-constant import additions shift module
    // globals up, so without scalar-field fixup the captured idx becomes stale
    // and emitSetArgc emits `global.set <stale>` targeting a __tdz_* slot
    // instead of __argc — which both leaves __argc at sentinel -1 and corrupts
    // the TDZ flag, causing a runtime trap.
    const exp = await compileAndInstantiate(`
      function f_arg() { return arguments; }
      let x = f_arg();
      let y: number = x.length;
      let z = x[0];
      if (y !== 0) throw "bad length";
      if (z !== undefined) throw "bad slot";
    `);
    if (exp.__module_init) exp.__module_init();
  });
});
