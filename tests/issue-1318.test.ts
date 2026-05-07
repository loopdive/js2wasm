// #1318 — Verify the test262 runner surfaces enough context on assertion
// failures: the source line of the failing assert, its line number, and a
// raised truncation limit so descriptive `assert.sameValue(actual, expected,
// "message...")` calls aren't cut mid-line.

import { describe, expect, it } from "vitest";
import { runTest262File } from "./test262-runner.js";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function withTempTest<T>(source: string, name: string, fn: (path: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "issue-1318-"));
  try {
    const path = join(dir, name);
    // Test262 runner expects the full test262/test path prefix to derive
    // a relative path; provide a path that contains it so output looks right.
    await writeFile(path, source);
    return await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("#1318 — test262 runner error context", () => {
  it("captures full assert source line on failure (no 160-char truncation)", async () => {
    // Construct a test that fails on the third assert — the line is intentionally
    // long enough that the previous 160-char limit would have truncated it.
    const longMessage =
      "this is a deliberately verbose descriptive assertion message used to verify that the runner does not truncate diagnostic context below 500 characters";
    const source = `
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/*---
description: probe — 3rd assert fails with a long message
---*/
assert.sameValue(1, 1);
assert.sameValue(2, 2);
assert.sameValue(3, 4, "${longMessage}");
`;
    await withTempTest(source, "issue-1318-long-assert.js", async (path) => {
      const result = await runTest262File(path, "smoke");
      expect(result.status).toBe("fail");
      // The error must contain the full long message — verifies the 160→600
      // bump in test262-runner.ts AND no downstream 300-char cut on the
      // worker (handled by test262-worker-esm.mjs separately).
      expect(result.error).toContain(longMessage);
      // The error must include the line number (an explicit format change
      // in the #1318 fix: `assert #N at L<line>: <source>`).
      expect(result.error).toMatch(/at L\d+:/);
    });
  });

  it("preserves the Test262Error message text in the error field", async () => {
    // A test that fails by throwing Test262Error directly. The runner's
    // replaceThrowTest262Error pipeline routes the throw value through to
    // the captured `error` field — verify the descriptive message survives
    // without being truncated below the new 2000-char downstream limit.
    const source = `
/*---
description: probe — throws Test262Error directly
---*/
function check(x) {
  if (x !== 99) throw new Test262Error("custom message about " + x);
}
check(99);
check(100);
`;
    await withTempTest(source, "issue-1318-throw.js", async (path) => {
      const result = await runTest262File(path, "smoke");
      expect(result.status).toBe("fail");
      // The Test262Error message was captured — the actual interpolated
      // value (`100`) reached the error field intact.
      expect(result.error).toContain("custom message about 100");
    });
  }, 30_000);

  it("includes line number in the assert context (new format)", async () => {
    // Verify the new `at L<n>:` format is present (added in #1318 alongside
    // the truncation bump). Pre-fix the format was `assert #N: <line>` with
    // no L<n> prefix.
    const source = `
/*---
description: probe — line number in assert context
---*/
assert.sameValue(1, 1);
// some
// padding
// to make
// the failing
// assert appear
// on a
// non-trivial
// line
assert.sameValue(2, 3);
`;
    await withTempTest(source, "issue-1318-line.js", async (path) => {
      const result = await runTest262File(path, "smoke");
      expect(result.status).toBe("fail");
      expect(result.error).toMatch(/at L1[0-9]:/); // line 14-ish
    });
  });
});
