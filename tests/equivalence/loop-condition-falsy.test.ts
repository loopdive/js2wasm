import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("loop condition falsy value handling", () => {
  it("while(NaN) should not enter loop body", async () => {
    await assertEquivalent(
      `export function test(): number {
        var result = 42;
        while (NaN) { result = 99; break; }
        return result;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("while(undefined) should not enter loop body", async () => {
    await assertEquivalent(
      `export function test(): number {
        var result = 42;
        while (undefined) { result = 99; break; }
        return result;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("while(null) should not enter loop body", async () => {
    await assertEquivalent(
      `export function test(): number {
        var result = 42;
        while (null) { result = 99; break; }
        return result;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("while(0) should not enter loop body", async () => {
    await assertEquivalent(
      `export function test(): number {
        var result = 42;
        while (0) { result = 99; break; }
        return result;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("for(;NaN;) should not enter loop body", async () => {
    await assertEquivalent(
      `export function test(): number {
        var result = 42;
        for (var i = 0; NaN; i++) { result = 99; break; }
        return result;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("object literal in while condition is truthy", async () => {
    await assertEquivalent(
      `export function test(): number {
        var result = 0;
        var obj: any = {};
        while (obj) { result = 1; break; }
        return result;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("truthy number in while condition enters loop", async () => {
    await assertEquivalent(
      `export function test(): number {
        var result = 0;
        while (1) { result = 1; break; }
        return result;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("Infinity is truthy in while condition", async () => {
    await assertEquivalent(
      `export function test(): number {
        var result = 0;
        while (Infinity) { result = 1; break; }
        return result;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("negative zero is falsy in while condition", async () => {
    await assertEquivalent(
      `export function test(): number {
        var result = 42;
        while (-0) { result = 99; break; }
        return result;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("NaN variable in for loop condition", async () => {
    await assertEquivalent(
      `export function test(): number {
        var x: number = NaN;
        var result = 42;
        for (; x;) { result = 99; break; }
        return result;
      }`,
      [{ fn: "test", args: [] }],
    );
  });
});
