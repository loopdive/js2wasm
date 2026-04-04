import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";
import { readFileSync } from "fs";
import { parseMeta, wrapTest } from "./test262-runner.ts";

// Representative samples from the 16 regressions (FAIL→CE) in class dstr
// Non-async: fixed by pushBody/popBody (no more f64.add type mismatch)
const nonAsyncTests = [
  "test262/test/language/statements/class/dstr/private-gen-meth-dflt-ary-ptrn-elem-ary-rest-iter.js",
  "test262/test/language/statements/class/dstr/private-gen-meth-static-dflt-ary-ptrn-elem-ary-rest-iter.js",
  "test262/test/language/expressions/class/dstr/private-gen-meth-dflt-ary-ptrn-elem-ary-rest-iter.js",
  "test262/test/language/expressions/class/dstr/private-gen-meth-static-dflt-ary-ptrn-elem-ary-rest-iter.js",
];

// Async variants have a pre-existing second CE (extern.convert_any)
const asyncTests = [
  "test262/test/language/statements/class/dstr/async-private-gen-meth-dflt-ary-ptrn-elem-ary-rest-iter.js",
  "test262/test/language/statements/class/dstr/async-private-gen-meth-static-dflt-ary-ptrn-elem-ary-rest-iter.js",
  "test262/test/language/expressions/class/dstr/async-private-gen-meth-dflt-ary-ptrn-elem-ary-rest-iter.js",
  "test262/test/language/expressions/class/dstr/async-private-gen-meth-static-dflt-ary-ptrn-elem-ary-rest-iter.js",
];

describe("Issue #921 — class dstr generator/private-method CE regression", () => {
  describe("non-async variants (primary fix)", () => {
    for (const tp of nonAsyncTests) {
      const name = tp.split("/").pop()!;
      it(`should compile and instantiate: ${name}`, async () => {
        const src = readFileSync(tp, "utf-8");
        const meta = parseMeta(src);
        const { source: w } = wrapTest(src, meta);
        const r = compile(w, { fileName: "test.ts" });
        expect(r.success).toBe(true);
        if (r.success) {
          const imports = buildImports(r.imports, undefined, r.stringPool);
          const { instance } = await WebAssembly.instantiate(r.binary, imports);
          expect(instance).toBeDefined();
        }
      });
    }
  });

  describe("async variants (original f64.add CE is gone)", () => {
    for (const tp of asyncTests) {
      const name = tp.split("/").pop()!;
      it(`should not have f64.add type mismatch: ${name}`, async () => {
        const src = readFileSync(tp, "utf-8");
        const meta = parseMeta(src);
        const { source: w } = wrapTest(src, meta);
        const r = compile(w, { fileName: "test.ts" });
        if (!r.success) {
          const msg = (r as any).errors[0]?.message || "";
          expect(msg).not.toContain("f64.add");
        }
      });
    }
  });
});
