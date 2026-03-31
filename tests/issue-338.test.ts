/**
 * Tests for negative test support in the test262 runner (#338).
 *
 * Validates that:
 * 1. parseMeta correctly extracts negative metadata
 * 2. shouldSkip no longer skips negative tests
 * 3. handleNegativeTest passes when compile fails for parse/early phase
 * 4. handleNegativeTest fails when compile succeeds for parse/early phase
 * 5. Runtime negative tests pass when execution traps
 */
import { describe, it, expect } from "vitest";
import { parseMeta, shouldSkip, handleNegativeTest, type Test262Meta } from "./test262-runner.js";

describe("issue #338: negative test support", () => {
  describe("parseMeta extracts negative metadata", () => {
    it("parses negative with phase and type", () => {
      const source = `/*---
description: test
negative:
  phase: parse
  type: SyntaxError
---*/
var x = ;`;
      const meta = parseMeta(source);
      expect(meta.negative).toBeDefined();
      expect(meta.negative!.phase).toBe("parse");
      expect(meta.negative!.type).toBe("SyntaxError");
    });

    it("parses runtime phase negative", () => {
      const source = `/*---
description: test
negative:
  phase: runtime
  type: ReferenceError
---*/
undeclaredVar;`;
      const meta = parseMeta(source);
      expect(meta.negative).toBeDefined();
      expect(meta.negative!.phase).toBe("runtime");
      expect(meta.negative!.type).toBe("ReferenceError");
    });

    it("returns undefined for non-negative tests", () => {
      const source = `/*---
description: normal test
---*/
var x = 1;`;
      const meta = parseMeta(source);
      expect(meta.negative).toBeUndefined();
    });
  });

  describe("shouldSkip does not skip negative tests", () => {
    it("does not skip parse-phase negative tests", () => {
      const source = `/*---
negative:
  phase: parse
  type: SyntaxError
---*/
var x = ;`;
      const meta = parseMeta(source);
      const result = shouldSkip(source, meta);
      // Should not skip just because it's negative
      expect(result.reason).not.toBe("negative test");
    });

    it("does not skip runtime-phase negative tests", () => {
      const source = `/*---
negative:
  phase: runtime
  type: ReferenceError
---*/
var x = 1;`;
      const meta = parseMeta(source);
      const result = shouldSkip(source, meta);
      expect(result.reason).not.toBe("negative test");
    });
  });

  describe("handleNegativeTest", () => {
    it("returns null for non-negative tests", async () => {
      const meta: Test262Meta = { description: "normal test" };
      const result = await handleNegativeTest("var x = 1;", meta, "test.js", "test");
      expect(result).toBeNull();
    });

    it("passes for parse-phase when source has invalid syntax", async () => {
      // This source has intentionally broken syntax that should fail to compile
      const source = `/*---
negative:
  phase: parse
  type: SyntaxError
---*/
function f(,) {}`;
      const meta: Test262Meta = {
        negative: { phase: "parse", type: "SyntaxError" },
      };
      const result = await handleNegativeTest(source, meta, "test.js", "test");
      expect(result).not.toBeNull();
      expect(result!.status).toBe("pass");
    });

    it("passes for early-phase when source has early error", async () => {
      // Use syntax that will definitely fail: an invalid token sequence
      const source = `/*---
negative:
  phase: early
  type: SyntaxError
---*/
if ( { }`;
      const meta: Test262Meta = {
        negative: { phase: "early", type: "SyntaxError" },
      };
      const result = await handleNegativeTest(source, meta, "test.js", "test");
      expect(result).not.toBeNull();
      expect(result!.status).toBe("pass");
    });

    it("fails for parse-phase when source compiles successfully", async () => {
      // Valid code — negative test should fail because no parse error occurred
      const source = `/*---
negative:
  phase: parse
  type: SyntaxError
---*/
var x = 1;`;
      const meta: Test262Meta = {
        negative: { phase: "parse", type: "SyntaxError" },
      };
      const result = await handleNegativeTest(source, meta, "test.js", "test");
      expect(result).not.toBeNull();
      // This could be "pass" if wasm instantiation fails, or "fail" if everything works.
      // Since `var x = 1; export {};` is valid, it should compile and instantiate,
      // so the negative test should fail.
      expect(result!.status).toBe("fail");
    });

    it("returns null for runtime-phase (handled by runTest262File)", async () => {
      const meta: Test262Meta = {
        negative: { phase: "runtime", type: "TypeError" },
      };
      const result = await handleNegativeTest("var x = 1;", meta, "test.js", "test");
      expect(result).toBeNull();
    });

    it("handles resolution phase (same as parse/early)", async () => {
      // Resolution phase negative tests are compiled like parse/early.
      // This source has valid syntax, so the test should fail (compilation succeeds).
      const meta: Test262Meta = {
        negative: { phase: "resolution", type: "SyntaxError" },
      };
      const result = await handleNegativeTest("var x = 1;", meta, "test.js", "test");
      expect(result).not.toBeNull();
      // Valid code compiles successfully, so negative test fails
      expect(result!.status).toBe("fail");
    });
  });
});
