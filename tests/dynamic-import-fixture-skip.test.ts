/**
 * Test for issue #333 — Dynamic import FIXTURE files are properly skipped
 *
 * FIXTURE files in test262/test/language/expressions/dynamic-import/ use
 * export syntax that TypeScript rejects ("Modifiers cannot appear here").
 * These are auxiliary module files, not standalone tests. Both findTestFiles
 * and shouldSkip must exclude them.
 */
import { describe, it, expect } from "vitest";
import { findTestFiles, shouldSkip, parseMeta } from "./test262-runner.js";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

describe("Issue #333: dynamic-import FIXTURE files", () => {
  it("findTestFiles excludes _FIXTURE files", () => {
    const files = findTestFiles("language/expressions/dynamic-import");
    for (const f of files) {
      expect(f).not.toMatch(/_FIXTURE\.js$/);
    }
  });

  it("shouldSkip returns skip=true for FIXTURE file paths", () => {
    const fixtureSource = "export var x = 1;";
    const meta = {};
    const result = shouldSkip(
      fixtureSource,
      meta as any,
      "/some/path/test262/test/language/expressions/dynamic-import/catch/instn-iee-err-ambiguous-1_FIXTURE.js",
    );
    expect(result.skip).toBe(true);
    expect(result.reason).toContain("FIXTURE");
  });

  it("shouldSkip does not skip non-FIXTURE files with export syntax", () => {
    const source = "export var x = 1;";
    const meta = {};
    const result = shouldSkip(
      source,
      meta as any,
      "/some/path/test262/test/language/expressions/dynamic-import/some-regular-test.js",
    );
    // Non-FIXTURE files should not be skipped by the FIXTURE filter
    // (they may be skipped by other filters, but not the FIXTURE one)
    if (result.skip) {
      expect(result.reason).not.toContain("FIXTURE");
    }
  });

  it("shouldSkip skips tests that import _FIXTURE files", () => {
    const source = `import('./instn-iee-err-ambiguous-1_FIXTURE.js').then(...)`;
    const meta = { features: ["dynamic-import"] };
    const result = shouldSkip(source, meta as any);
    expect(result.skip).toBe(true);
  });
});
