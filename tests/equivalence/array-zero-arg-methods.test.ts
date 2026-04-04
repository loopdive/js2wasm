import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";
import { buildImports } from "./helpers.js";

describe("Array 0-arg methods (#840)", () => {
  it("concat() with 0 args should not produce compile error", async () => {
    // The fix removes the "concat requires at least 1 argument" error
    // Test that the compiler accepts 0-arg concat without error
    const src = `
      var x: number[] = [10, 20];
      var arr = x.concat();
      export function test(): number { return 1; }
    `;
    const result = compile(src, { fileName: "test.ts" });
    // Should compile without the "concat requires" error
    const concatError = result.errors?.find((e) => e.message.includes("concat requires"));
    expect(concatError).toBeUndefined();
  });

  it("push() with 0 args should not produce compile error", async () => {
    const src = `
      var x: number[] = [10, 20, 30];
      var len = x.push();
      export function test(): number { return 1; }
    `;
    const result = compile(src, { fileName: "test.ts" });
    const pushError = result.errors?.find((e) => e.message.includes("push requires"));
    expect(pushError).toBeUndefined();
  });

  it("splice() with 0 args should not produce compile error", async () => {
    const src = `
      var x: number[] = [10, 20, 30];
      var removed = x.splice();
      export function test(): number { return 1; }
    `;
    const result = compile(src, { fileName: "test.ts" });
    const spliceError = result.errors?.find((e) => e.message.includes("splice requires"));
    expect(spliceError).toBeUndefined();
  });
});
