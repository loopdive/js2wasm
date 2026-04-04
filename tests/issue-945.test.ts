import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";
import { readFileSync } from "fs";
import { parseMeta, wrapTest } from "./test262-runner.ts";
import { buildImports } from "../src/runtime.ts";

const T262 = "/workspace/test262";
const SAMPLES = [
  `${T262}/test/built-ins/ArrayBuffer/isView/invoked-as-a-fn.js`,
  `${T262}/test/built-ins/TypedArray/prototype/copyWithin/bit-precision.js`,
];

describe("#945 __vec_get i32_byte boxing fix", () => {
  for (const sample of SAMPLES) {
    const label = sample.split("/").slice(-3).join("/");

    it(`compiles without extern.convert_any CE: ${label}`, () => {
      const src = readFileSync(sample, "utf-8");
      const meta = parseMeta(src);
      const { source: w } = wrapTest(src, meta);
      const r = compile(w, { fileName: "test.ts" });
      // The fix: i32_byte elements must not hit extern.convert_any
      // Before fix: CE "extern.convert_any[0] expected type shared anyref, found array.get of type i32"
      if (!r.success) {
        const err = r.errors[0]?.message ?? "";
        expect(err).not.toMatch(/extern\.convert_any.*expected type.*anyref.*found.*i32/);
      }
      expect(r.success).toBe(true);
    });

    it(`instantiates without CompileError: ${label}`, async () => {
      const src = readFileSync(sample, "utf-8");
      const meta = parseMeta(src);
      const { source: w } = wrapTest(src, meta);
      const r = compile(w, { fileName: "test.ts" });
      if (!r.success) return; // already covered above
      const imports = buildImports(r.imports, undefined, r.stringPool);
      // Must not throw WebAssembly.CompileError — instantiation should succeed
      await expect(WebAssembly.instantiate(r.binary, imports)).resolves.toBeDefined();
    });
  }
});
