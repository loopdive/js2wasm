import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";
import { readFileSync, readdirSync } from "fs";
import { parseMeta, wrapTest } from "./test262-runner.ts";

// Representative samples from the issue description
const namedSamples = [
  "test262/test/language/arguments-object/cls-decl-async-private-gen-meth-static-args-trailing-comma-null.js",
  "test262/test/language/arguments-object/cls-decl-private-gen-meth-static-args-trailing-comma-spread-operator.js",
  "test262/test/language/arguments-object/cls-expr-async-private-gen-meth-static-args-trailing-comma-multiple.js",
  "test262/test/language/arguments-object/cls-expr-private-gen-meth-static-args-trailing-comma-single-args.js",
  "test262/test/language/expressions/class/elements/async-gen-private-method-static/yield-promise-reject-next.js",
  "test262/test/language/expressions/class/elements/async-gen-private-method-static/yield-star-async-throw.js",
  "test262/test/language/expressions/class/elements/async-gen-private-method-static/yield-star-getiter-async-returns-abrupt.js",
  "test262/test/language/statements/class/elements/async-gen-private-method-static/yield-star-next-then-returns-abrupt.js",
];

// Additional representative samples from wider argument-object patterns
const argsObjectSamples = [
  "test262/test/language/arguments-object/cls-decl-private-gen-meth-static-args-trailing-comma-null.js",
  "test262/test/language/arguments-object/cls-expr-async-private-gen-meth-static-args-trailing-comma-null.js",
];

describe("Issue #984 — undefined AST nodes in private generator methods", () => {
  for (const tp of [...namedSamples, ...argsObjectSamples]) {
    const name = tp.split("/").pop()!;
    it(`should compile: ${name}`, () => {
      const src = readFileSync(tp, "utf-8");
      const meta = parseMeta(src);
      const { source: w } = wrapTest(src, meta);
      const r = compile(w, { fileName: "test.ts" });
      if (!r.success) {
        console.log("CE:", r.errors[0]?.message);
      }
      expect(r.success).toBe(true);
    });
  }
});
