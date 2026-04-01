import { describe, expect, it } from "vitest";
import { classifyTestScope, parseMeta, shouldSkip } from "./test262-runner.js";

describe("test262 scope classification", () => {
  it("treats annexB tests as official but separate scope", () => {
    const source = "/*---\ndescription: annex b test\n---*/\n";
    const meta = parseMeta(source);
    const scope = classifyTestScope(source, meta, "/tmp/test262/test/annexB/language/foo.js");

    expect(scope).toEqual({
      scope: "annex_b",
      official: true,
      reason: "Annex B",
    });
  });

  it("treats staging tests as proposals", () => {
    const source = "/*---\ndescription: staging proposal test\n---*/\n";
    const meta = parseMeta(source);
    const scope = classifyTestScope(source, meta, "/tmp/test262/test/staging/decorators/example.js");

    expect(scope.scope).toBe("proposal");
    expect(scope.official).toBe(false);
  });

  it("skips proposal features by default", () => {
    const source = "/*---\nfeatures: [source-phase-imports]\n---*/\n";
    const meta = parseMeta(source);
    const result = shouldSkip(source, meta, "/tmp/test262/test/language/import/example.js");

    expect(result).toEqual({
      skip: true,
      reason: "Proposal excluded from default scope: proposal feature: source phase imports",
    });
  });
});
