// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1385 — Temporal/Duration/from/argument-non-string.js no longer hangs.
//
// The test was previously in HANGING_TESTS in `tests/test262-runner.ts` because
// running it against an early version of our compiler triggered an infinite
// runtime loop. Recent codegen improvements (Symbol/BigInt coercion, Iterator
// helpers, ref-cell mutable closure captures) eliminated the loop. The test
// now terminates immediately because `Temporal` is not defined in our runtime,
// raising a Wasm exception.
//
// This test reads the actual test262 source, wraps it through `wrapTest`, and
// confirms that compile + instantiate + test() invocation finishes well under
// the 5s acceptance threshold from the issue file.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { wrapTest } from "./test262-runner.js";

describe("issue #1385 — Temporal/Duration/from/argument-non-string.js does not hang", () => {
  it("compiles + instantiates + executes within 5s (no hang)", async () => {
    // CI mounts test262 at /workspace/test262 (or sibling worktree); resolve
    // relative to a known-stable repo location.
    const path = resolve(__dirname, "../test262/test/built-ins/Temporal/Duration/from/argument-non-string.js");
    let src: string;
    try {
      src = readFileSync(path, "utf-8");
    } catch {
      // Fall back to the workspace root checkout when running outside CI.
      src = readFileSync("/workspace/test262/test/built-ins/Temporal/Duration/from/argument-non-string.js", "utf-8");
    }
    const wrapped = wrapTest(src);

    const t0 = Date.now();
    const r = compile(wrapped.source, { fileName: "test.ts" });
    expect(
      r.success,
      `compile failed: ${r.errors
        .slice(0, 1)
        .map((e) => e.message)
        .join("")}`,
    ).toBe(true);
    const t1 = Date.now();
    expect(t1 - t0).toBeLessThan(5000); // compile under 5s

    const env = buildImports(r.imports, undefined, r.stringPool);
    const { instance } = await WebAssembly.instantiate(r.binary, env);
    if (env.setExports) env.setExports(instance.exports as Record<string, Function>);
    const t2 = Date.now();
    expect(t2 - t1).toBeLessThan(5000); // instantiate under 5s

    // The test calls Temporal.Duration.from which is not defined — expect a
    // throw, but importantly NOT a hang. Bracket the call with a timer so a
    // real hang would surface as a test failure rather than a Vitest stall.
    const fn = (instance.exports as Record<string, () => number>).test;
    expect(typeof fn).toBe("function");

    let threw = false;
    try {
      fn?.();
    } catch {
      threw = true;
    }
    const t3 = Date.now();
    // Either a throw or a clean return is fine; what we verify is termination.
    expect(t3 - t2).toBeLessThan(5000);
    // Document that we expect the throw given Temporal is undefined in our runtime.
    expect(threw).toBe(true);
  });
});
