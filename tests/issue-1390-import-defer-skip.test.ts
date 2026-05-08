/**
 * Tests for issue #1390: import-defer proposal tests show as CE
 * "no test export" when TEST262_INCLUDE_PROPOSALS=1.
 *
 * The fix adds a path-based skip in `shouldSkip` for
 * `language/import/import-defer/` that runs unconditionally, before the
 * proposal-scope env-var check, so these syntax-only tests are always
 * skipped — regardless of TEST262_INCLUDE_PROPOSALS.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseMeta, shouldSkip } from "./test262-runner.js";

describe("issue #1390: import-defer tests are always skipped", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // Mirrors test262/test/language/import/import-defer/syntax/invalid-defer-default.js
  const SYNTAX_NEGATIVE = `// Copyright (C) 2024 Igalia, S.L. All rights reserved.
/*---
esid: sec-imports
description: \`import defer\` cannot be used with default imports
features: [import-defer]
negative:
  phase: parse
  type: SyntaxError
---*/

$DONOTEVALUATE();

import defer x from "./dep_FIXTURE.js";
`;

  // Mirrors test262/test/language/import/import-defer/deferred-namespace-object/exotic-object-behavior.js
  const RUNTIME_TEST = `/*---
esid: sec-modulenamespacecreate
description: Deferred namespace objects have the correct MOP implementation
flags: [module]
features: [import-defer]
includes: [propertyHelper.js, compareArray.js]
---*/

import defer * as ns from "./dep_FIXTURE.js";
assert.sameValue(typeof ns, "object", "Deferred namespaces are objects");
`;

  const FILE_PATH_SYNTAX = "test262/test/language/import/import-defer/syntax/invalid-defer-default.js";
  const FILE_PATH_RUNTIME =
    "test262/test/language/import/import-defer/deferred-namespace-object/exotic-object-behavior.js";

  it("skips syntax-negative import-defer tests when proposals are EXCLUDED", () => {
    vi.stubEnv("TEST262_INCLUDE_PROPOSALS", "");
    const meta = parseMeta(SYNTAX_NEGATIVE);
    const result = shouldSkip(SYNTAX_NEGATIVE, meta, FILE_PATH_SYNTAX);
    expect(result.skip).toBe(true);
  });

  it("skips syntax-negative import-defer tests when proposals are INCLUDED", () => {
    vi.stubEnv("TEST262_INCLUDE_PROPOSALS", "1");
    const meta = parseMeta(SYNTAX_NEGATIVE);
    const result = shouldSkip(SYNTAX_NEGATIVE, meta, FILE_PATH_SYNTAX);
    expect(result.skip).toBe(true);
    expect(result.reason).toContain("import defer");
  });

  it("skips runtime import-defer namespace tests when proposals are INCLUDED", () => {
    vi.stubEnv("TEST262_INCLUDE_PROPOSALS", "1");
    const meta = parseMeta(RUNTIME_TEST);
    const result = shouldSkip(RUNTIME_TEST, meta, FILE_PATH_RUNTIME);
    expect(result.skip).toBe(true);
    expect(result.reason).toContain("import defer");
  });

  it("does NOT skip unrelated import tests when proposals are INCLUDED", () => {
    vi.stubEnv("TEST262_INCLUDE_PROPOSALS", "1");
    const source = `/*---
description: regular import test
flags: [module]
---*/
import { x } from "./dep.js";
export function test() { return 1; }
`;
    const meta = parseMeta(source);
    const result = shouldSkip(source, meta, "test262/test/language/import/some-other.js");
    expect(result.skip).toBe(false);
  });

  it("does NOT skip when filePath is undefined (defensive: no false skip)", () => {
    const meta = parseMeta(SYNTAX_NEGATIVE);
    // Without filePath we cannot pattern-match on the path. The proposal
    // env-var path still applies; with proposals INCLUDED the test would
    // fall through to the rest of the runner, which is the pre-fix behavior.
    vi.stubEnv("TEST262_INCLUDE_PROPOSALS", "1");
    const result = shouldSkip(SYNTAX_NEGATIVE, meta, undefined);
    // No path-based skip can fire; result depends on other filters but
    // should NOT be skipped purely because of the import-defer feature.
    expect(result.reason ?? "").not.toContain("import defer (no test harness)");
  });
});
