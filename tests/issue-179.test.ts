/**
 * Issue #179 — Generator functions: yield in module mode errors
 *
 * Tests that the wrapTest transform correctly handles `yield`:
 *   - Inside generator bodies: preserved as the yield keyword
 *   - Outside generator bodies: renamed to _yield (reserved in strict mode)
 *   - Mixed: generators + yield-as-identifier in same source
 */
import { describe, it, expect } from "vitest";
import { wrapTest } from "./test262-runner.js";

describe("issue-179: yield in module mode", () => {
  it("renames yield to _yield when no generators present", () => {
    const source = `/*---
description: test
---*/
var yield = 42;
assert.sameValue(yield, 42);`;
    const wrapped = wrapTest(source);
    // yield should be renamed to _yield
    expect(wrapped).toContain("_yield");
    expect(wrapped).not.toMatch(/\bvar yield\b/);
  });

  it("preserves yield inside generator function body", () => {
    const source = `/*---
description: test
---*/
function* g() {
  yield 1;
  yield 2;
}`;
    const wrapped = wrapTest(source);
    // yield inside generator should be preserved
    expect(wrapped).toContain("yield 1");
    expect(wrapped).toContain("yield 2");
    expect(wrapped).not.toContain("_yield 1");
    expect(wrapped).not.toContain("_yield 2");
  });

  it("renames yield outside generator but preserves inside", () => {
    const source = `/*---
description: test
---*/
var yield = 10;
function* gen() {
  yield 1;
  yield 2;
}
assert.sameValue(yield, 10);`;
    const wrapped = wrapTest(source);
    // yield as identifier (outside generator) should be renamed
    expect(wrapped).toContain("var _yield");
    expect(wrapped).toContain("_yield, 10");
    // yield as keyword (inside generator) should be preserved
    expect(wrapped).toContain("yield 1");
    expect(wrapped).toContain("yield 2");
  });

  it("handles named generator functions", () => {
    const source = `/*---
description: test
---*/
function* myGen(x) {
  yield x;
  yield x + 1;
}`;
    const wrapped = wrapTest(source);
    expect(wrapped).toContain("yield x");
    expect(wrapped).toContain("yield x + 1");
    expect(wrapped).not.toContain("_yield");
  });

  it("handles multiple generator functions", () => {
    const source = `/*---
description: test
---*/
function* gen1() {
  yield 1;
}
function* gen2() {
  yield 2;
}`;
    const wrapped = wrapTest(source);
    expect(wrapped).toContain("yield 1");
    expect(wrapped).toContain("yield 2");
    expect(wrapped).not.toContain("_yield");
  });

  it("handles nested braces inside generator", () => {
    const source = `/*---
description: test
---*/
function* gen() {
  if (true) {
    yield 1;
  }
  for (var i = 0; i < 3; i++) {
    yield i;
  }
}`;
    const wrapped = wrapTest(source);
    expect(wrapped).toContain("yield 1");
    expect(wrapped).toContain("yield i");
    expect(wrapped).not.toContain("_yield");
  });

  it("handles generator with yield outside after generator ends", () => {
    const source = `/*---
description: test
---*/
function* gen() {
  yield 1;
}
var yield = 99;`;
    const wrapped = wrapTest(source);
    // yield inside generator preserved
    expect(wrapped).toContain("yield 1");
    // yield as identifier outside renamed
    expect(wrapped).toContain("var _yield = 99");
  });

  it("handles yield as identifier before generator", () => {
    const source = `/*---
description: test
---*/
var yield = 5;
function* gen() {
  yield 1;
}`;
    const wrapped = wrapTest(source);
    expect(wrapped).toContain("var _yield = 5");
    expect(wrapped).toContain("yield 1");
  });

  it("no yield at all leaves code unchanged", () => {
    const source = `/*---
description: test
---*/
var x = 1;
assert.sameValue(x, 1);`;
    const wrapped = wrapTest(source);
    expect(wrapped).not.toContain("_yield");
    expect(wrapped).not.toContain("yield");
  });
});
