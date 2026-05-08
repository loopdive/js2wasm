/**
 * Issue #1378 — try/catch/finally semantics.
 *
 * This PR addresses sub-issue #C: catch destructuring (`catch ([x])` and
 * variants) must follow the §13.3.3.6 iterator protocol on the thrown value.
 * The previous emitter used direct property access (`exn[0]`), which silently
 * skipped Symbol.iterator and missed throws from the iterable.
 */
import { describe, expect, it } from "vitest";
import { compileToWasm } from "./equivalence/helpers.ts";
import { runTest262File } from "./test262-runner.ts";

describe("#1378 catch destructuring iterator protocol", () => {
  it("catch ([x]) on plain array binds first elem", async () => {
    const src = `
export function test(): number {
  try {
    throw [10, 20, 30];
  } catch ([a, b, c]) {
    return (a as number) + (b as number) + (c as number);
  }
  return -1;
}
`;
    const r = await compileToWasm(src);
    expect((r as any).test()).toBe(60);
  });

  it("catch ({x}) still uses property access (not iterator protocol)", async () => {
    const src = `
export function test(): number {
  try {
    throw { x: 42, y: 100 };
  } catch ({ x, y }) {
    return (x as number) + (y as number);
  }
  return -1;
}
`;
    const r = await compileToWasm(src);
    expect((r as any).test()).toBe(142);
  });

  it("catch ([]) empty pattern is a no-op (no iterator invocation)", async () => {
    const src = `
let iterCalled = 0;
export function test(): number {
  const bad: any = {
    [Symbol.iterator]() {
      iterCalled = 1;
      throw "should-not-fire";
    },
  };
  try {
    throw bad;
  } catch ([]) {
    // Empty pattern: spec says no IteratorBindingInitialization steps.
  }
  return iterCalled;
}
`;
    const r = await compileToWasm(src);
    expect((r as any).test()).toBe(0);
  });

  it("test262: ary-init-iter-get-err.js — catch [x] propagates iter throw", async () => {
    const result = await runTest262File(
      "/workspace/test262/test/language/statements/try/dstr/ary-init-iter-get-err.js",
      "language",
    );
    expect(result.status).toBe("pass");
  });
});
