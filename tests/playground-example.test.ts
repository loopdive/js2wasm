import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import * as fs from "fs";

describe("playground", () => {
  it("compiles and instantiates", async () => {
    const mainTs = fs.readFileSync("playground/main.ts", "utf8");
    const m = mainTs.match(/const DEFAULT_SOURCE = `([\s\S]*?)`;/);
    expect(m).toBeTruthy();
    const source = m![1];
    const result = compile(source);
    if (result.errors.length > 0) {
      console.log("Compile errors:", result.errors);
    }
    expect(result.success).toBe(true);
    expect(result.binary.length).toBeGreaterThan(0);
    console.log("Binary size:", result.binary.length, "bytes");

    const { jsString, buildImports } = await import("../src/runtime.js");
    const imports = buildImports(result.imports);
    try {
      const { instance } = await WebAssembly.instantiate(result.binary, {
        env: imports.env,
        string_constants: imports.string_constants,
      } as any);
      console.log("OK, exports:", Object.keys(instance.exports));
    } catch {
      const { instance } = await WebAssembly.instantiate(result.binary, imports as any);
      console.log("OK (js-string), exports:", Object.keys(instance.exports));
    }
  });
});
