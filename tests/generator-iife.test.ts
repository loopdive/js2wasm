import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

describe("Issue #657: Generator function expression IIFE should not be inlined", () => {
  it("(function* () { yield; yield; })() compiles without errors", () => {
    const src = `
export function test(): number {
  const iter = (function* () {
    yield 1;
    yield 2;
  })();
  const r1 = iter.next();
  const r2 = iter.next();
  return 1;
}
`;
    const result = compile(src, { fileName: "test.ts" });
    const errors = result.errors.filter((e) => e.severity === "error");
    expect(errors).toEqual([]);
  });

  it("generator IIFE inside try-catch compiles without errors", () => {
    const src = `
let __fail: number = 0;
export function test(): number {
  try {
    const iter = (function* () {
      yield;
      yield;
    })();
  } catch (e) {
    __fail = 1;
  }
  if (__fail) { return 0; }
  return 1;
}
`;
    const result = compile(src, { fileName: "test.ts" });
    const errors = result.errors.filter((e) => e.severity === "error");
    expect(errors).toEqual([]);
  });

  it("nested generator IIFE with for-of compiles without errors", () => {
    const src = `
export function test(): number {
  const iter = (function* () {
    for (let i = 1; i < 5; ++i) {
      yield i;
    }
  })();
  return 1;
}
`;
    const result = compile(src, { fileName: "test.ts" });
    const errors = result.errors.filter((e) => e.severity === "error");
    expect(errors).toEqual([]);
  });
});
