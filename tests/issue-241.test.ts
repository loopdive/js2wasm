/**
 * Issue #241: Yield expression in strict mode / module context
 *
 * Tests that:
 * 1. The compiler downgrades diagnostic 1214 (yield as reserved word in strict mode)
 * 2. The wrapTest function properly renames yield identifiers in non-generator code
 * 3. Generator functions with yield inside their bodies compile without errors
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { wrapTest } from "./test262-runner.js";

describe("Issue #241: yield in strict mode", () => {
  it("should downgrade diagnostic 1214 for yield as identifier", () => {
    const result = compile(
      `
      var yield = 42;
      export function test(): number {
        return yield;
      }
      `,
      { fileName: "test.ts" },
    );
    // Compilation should succeed (diagnostic downgraded to warning)
    expect(result.success).toBe(true);
    // All errors should be warnings, not errors
    const errors = result.errors.filter((e) => e.severity === "error");
    expect(errors.length).toBe(0);
  });

  it("should compile generator functions with yield in module context", () => {
    const result = compile(
      `
      function* gen(): Generator<number> {
        yield 1;
        yield 2;
      }
      export function test(): number {
        return 1;
      }
      `,
      { fileName: "test.ts" },
    );
    expect(result.success).toBe(true);
    const errors = result.errors.filter((e) => e.severity === "error");
    expect(errors.length).toBe(0);
  });

  it("wrapTest should rename yield identifiers in non-generator code", () => {
    const source = `/*---
description: yield as identifier
---*/
var yield = 42;
assert.sameValue(yield, 42);
`;
    const wrapped = wrapTest(source);
    // yield should be renamed to _yield
    expect(wrapped).toContain("_yield");
    expect(wrapped).not.toMatch(/\bvar\s+yield\b/);
  });

  it("wrapTest should NOT rename yield inside generator functions", () => {
    const source = `/*---
description: yield inside generator
features: [generators]
---*/
function* gen() {
  yield 1;
  yield 2;
}
var iter = gen();
var result = iter.next();
assert.sameValue(result.value, 1);
`;
    const wrapped = wrapTest(source);
    // yield inside generator should remain as-is
    expect(wrapped).toContain("yield 1");
    expect(wrapped).toContain("yield 2");
  });

  it("wrapped yield-as-identifier test should not produce compile errors", () => {
    const source = `/*---
description: yield as identifier in sloppy mode
flags: [noStrict]
---*/
var yield = 42;
assert.sameValue(yield, 42);
`;
    const wrapped = wrapTest(source);
    const result = compile(wrapped, { fileName: "test.ts" });
    expect(result.success).toBe(true);
    const errors = result.errors.filter((e) => e.severity === "error");
    expect(errors.length).toBe(0);
  });
});
