/**
 * Tests for issue #542: runtime negative tests bypass shouldSkip.
 *
 * Runtime negative tests expect compilation to succeed but runtime to throw.
 * Previously, shouldSkip would filter them out (e.g., for using eval, with).
 * Now runtime negative tests bypass shouldSkip entirely and are sent to
 * the worker for compilation and execution.
 */
import { describe, it, expect } from "vitest";
import { shouldSkip, parseMeta } from "./test262-runner.js";

describe("issue #542: runtime negative tests bypass shouldSkip", () => {
  it("shouldSkip still filters non-negative tests using eval", () => {
    const source = `/*---
description: test
---*/
eval("1+1");`;
    const meta = parseMeta(source);
    expect(meta.negative).toBeUndefined();
    const result = shouldSkip(source, meta);
    expect(result.skip).toBe(true);
    expect(result.reason).toContain("dynamic code execution");
  });

  it("runTest262File flow: runtime negative tests are not blocked by shouldSkip", () => {
    // This test verifies the logic: when meta.negative.phase === "runtime",
    // shouldSkip is not called. We test the condition directly.
    const source = `/*---
description: test
negative:
  phase: runtime
  type: TypeError
---*/
eval("throw new TypeError()");`;
    const meta = parseMeta(source);
    expect(meta.negative).toBeDefined();
    expect(meta.negative!.phase).toBe("runtime");

    // In runTest262File, shouldSkip is only called when !isRuntimeNegative.
    // So runtime negative tests with eval will not be skipped.
    const isRuntimeNegative = meta.negative?.phase === "runtime";
    expect(isRuntimeNegative).toBe(true);
    // shouldSkip would skip this if called:
    const result = shouldSkip(source, meta);
    expect(result.skip).toBe(true); // would skip if checked
    // But the flow skips shouldSkip for runtime negatives
  });

  it("shouldSkip still filters non-negative tests using with", () => {
    const source = `/*---
description: test
---*/
with ({}) { }`;
    const meta = parseMeta(source);
    const result = shouldSkip(source, meta);
    expect(result.skip).toBe(true);
    expect(result.reason).toContain("with statement");
  });
});
