import { describe, it, expect } from "vitest";
import { wrapTest } from "./test262-runner.js";

describe("regression: throw-null/throw-undefined pattern via runner", () => {
  it("wrapTest produces assert_throwsAsync for assert.throwsAsync", () => {
    const src = `/*---
flags: [async]
features: [async-iteration]
includes: [asyncHelpers.js]
---*/
var asyncIterator = (async function* () { yield 1; })();
var thrownError = { name: "err" };
asyncTest(async function () {
  await assert.throwsAsync(TypeError, async () => {
    await asyncIterator.next();
    return asyncIterator.throw(thrownError);
  }, "Promise should be rejected");
  const result = await asyncIterator.next();
  assert(result.done, "the iterator is completed");
})
`;
    const result = wrapTest(src);
    // assert_throwsAsync should appear (from throwsAsync transformation)
    expect(result.source).toContain("assert_throwsAsync");
    // assert_throws should NOT appear with the async fn (old buggy behavior)
    expect(result.source).not.toMatch(/assert_throws\s*\(async/);
  });

  it("assert_throwsAsync function definition is in preamble when throwsAsync is used", () => {
    const src = `/*---
flags: [async]
features: [async-iteration]
includes: [asyncHelpers.js]
---*/
async function* gen() { yield 1; }
var asyncIterator = gen();
asyncTest(async function () {
  await assert.throwsAsync(TypeError, async () => {
    return asyncIterator.throw(new Error("x"));
  }, "should reject");
  const result = await asyncIterator.next();
  assert(result.done, "done");
})
`;
    const result = wrapTest(src);
    expect(result.source).toContain("function assert_throwsAsync");
    expect(result.source).toContain("typeof res.then === 'function'");
  });

  it("assert.throws (sync) still uses assert_throws (not assert_throwsAsync)", () => {
    const src = `/*---
---*/
function throwsFn() { throw new TypeError("x"); }
assert.throws(TypeError, throwsFn, "should throw");
`;
    const result = wrapTest(src);
    expect(result.source).toContain("assert_throws(");
    expect(result.source).not.toContain("assert_throwsAsync");
  });
});
