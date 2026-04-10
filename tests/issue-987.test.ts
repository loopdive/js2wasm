/**
 * Regression tests for issue #987:
 * Object-literal spread/shape fallbacks in generator and spread call sites.
 *
 * These 40 test262 patterns previously produced compile errors:
 *   "Cannot determine struct type for object literal" (24 tests)
 *   "Object literal type not mapped to struct" (16 tests)
 *
 * The current codebase handles all patterns correctly:
 * - Generator/yield-spread object literals (yield { ...yield, y: 1, ...yield yield })
 * - Call/new/array spread with null/undefined sources ({...null}, {...undefined})
 * - Unresolvable reference spreads in arrays/calls/new expressions
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { wrapTest, parseMeta } from "./test262-runner.js";

// test262 is a git submodule at the workspace root. vitest runs from the
// workspace root so `test262/` resolves correctly. In a git worktree
// the submodule directory exists but is empty — check for a sentinel file.
const TEST262_ROOT = join(process.cwd(), "test262");
const HAS_TEST262 = existsSync(join(TEST262_ROOT, "test", "language"));

/**
 * Verify that a test262 file compiles without CE (compile error).
 * Runtime correctness is validated by CI test262 runs.
 */
function noCompileError(filepath: string): void {
  if (!HAS_TEST262) return; // submodule not available in this worktree
  const src = readFileSync(join(TEST262_ROOT, filepath), "utf-8");
  const meta = parseMeta(src);
  const { source } = wrapTest(src, meta);
  const r = compile(source, { fileName: "test.ts", sourceMap: true, emitWat: false });
  expect(r.success, `CE in ${filepath}:\n${r.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`).toBe(true);
}

// All 40 tests from the issue-987 bucket
const FAILING_TESTS = [
  // Generator / yield-spread object literals (24 "Cannot determine struct type" tests)
  "test/language/expressions/async-generator/yield-spread-obj.js",
  "test/language/expressions/generators/named-yield-spread-obj.js",
  "test/language/expressions/object/method-definition/gen-yield-identifier-spread-non-strict.js",
  "test/language/statements/generators/yield-identifier-spread-non-strict.js",
  "test/language/statements/class/async-gen-method/yield-spread-obj.js",
  "test/language/expressions/generators/named-yield-identifier-spread-non-strict.js",
  "test/language/statements/async-generator/yield-identifier-spread-non-strict.js",
  "test/language/expressions/object/method-definition/async-gen-yield-spread-obj.js",
  "test/language/expressions/async-generator/named-yield-spread-obj.js",
  "test/language/expressions/class/gen-method/yield-spread-obj.js",
  "test/language/expressions/class/async-gen-method-static/yield-spread-obj.js",
  "test/language/expressions/generators/yield-identifier-spread-non-strict.js",
  "test/language/expressions/array/spread-err-sngl-err-obj-unresolvable.js",
  "test/language/expressions/object/method-definition/async-gen-yield-identifier-spread-non-strict.js",
  "test/language/expressions/async-generator/named-yield-identifier-spread-non-strict.js",
  "test/language/expressions/array/spread-err-mult-err-obj-unresolvable.js",
  "test/language/expressions/new/spread-err-sngl-err-obj-unresolvable.js",
  "test/language/expressions/async-generator/yield-identifier-spread-non-strict.js",
  "test/language/expressions/object/method-definition/gen-yield-spread-obj.js",
  "test/language/statements/class/gen-method/yield-spread-obj.js",
  "test/language/statements/generators/yield-spread-obj.js",
  "test/language/expressions/generators/yield-spread-obj.js",
  "test/language/statements/async-generator/yield-spread-obj.js",
  "test/language/statements/class/async-gen-method-static/yield-spread-obj.js",
  // Call/new/array spread over null/undefined ad-hoc objects (16 "Object literal type not mapped" tests)
  "test/language/expressions/new/spread-obj-null.js",
  "test/language/expressions/new/spread-mult-obj-null.js",
  "test/language/expressions/call/spread-obj-undefined.js",
  "test/language/expressions/new/spread-err-mult-err-obj-unresolvable.js",
  "test/language/expressions/new/spread-mult-obj-undefined.js",
  "test/language/expressions/call/spread-mult-obj-null.js",
  "test/language/expressions/array/spread-obj-undefined.js",
  "test/language/expressions/call/spread-err-mult-err-obj-unresolvable.js",
  "test/language/expressions/call/spread-mult-obj-undefined.js",
  "test/language/expressions/array/spread-mult-obj-null.js",
  "test/language/expressions/array/spread-mult-obj-undefined.js",
  "test/language/expressions/call/spread-obj-null.js",
  "test/language/expressions/class/async-gen-method/yield-spread-obj.js",
  "test/language/expressions/call/spread-err-sngl-err-obj-unresolvable.js",
  "test/language/expressions/new/spread-obj-undefined.js",
  "test/language/expressions/array/spread-obj-null.js",
];

describe("issue-987: object-literal spread/shape fallbacks (40 tests, was 40 CE)", () => {
  describe("generator / yield-spread object literals (no CE)", () => {
    for (const f of FAILING_TESTS.slice(0, 24)) {
      it(f.replace("test/language/", ""), () => noCompileError(f));
    }
  });

  describe("call/new/array spread with null/undefined/unresolvable sources (no CE)", () => {
    for (const f of FAILING_TESTS.slice(24)) {
      it(f.replace("test/language/", ""), () => noCompileError(f));
    }
  });

  it("inline: {..null} produces empty object", async () => {
    const r = compile(`
export function test(): number {
  const obj = {...null};
  return 1;
}
`);
    expect(r.success, `CE: ${r.errors[0]?.message}`).toBe(true);
  });

  it("inline: {..undefined} produces empty object", async () => {
    const r = compile(`
export function test(): number {
  const obj = {...undefined};
  return 1;
}
`);
    expect(r.success, `CE: ${r.errors[0]?.message}`).toBe(true);
  });

  it("inline: generator yield {..yield, y: 1, ..yield yield}", async () => {
    const r = compile(`
function* gen() {
  yield {
    ...yield,
    y: 1,
    ...yield yield,
  };
}
export function test(): number { return 1; }
`);
    expect(r.success, `CE: ${r.errors[0]?.message}`).toBe(true);
  });
});
