import { describe, it, expect } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("logical/conditional operators preserve object identity (#435)", () => {
  it("&& returns right operand when left is truthy (number)", async () => {
    await assertEquivalent(
      `export function test(): number {
        const x = 1;
        const y = 42;
        return (x && y);
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("&& returns left operand when left is falsy (number)", async () => {
    await assertEquivalent(
      `export function test(): number {
        const x = 0;
        const y = 42;
        return (x && y);
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("|| returns left operand when left is truthy (number)", async () => {
    await assertEquivalent(
      `export function test(): number {
        const x = 1;
        const y = 42;
        return (x || y);
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("|| returns right operand when left is falsy (number)", async () => {
    await assertEquivalent(
      `export function test(): number {
        const x = 0;
        const y = 42;
        return (x || y);
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("ternary returns correct branch value (number)", async () => {
    await assertEquivalent(
      `export function test(): number {
        return true ? 42 : 99;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("ternary returns correct branch value false (number)", async () => {
    await assertEquivalent(
      `export function test(): number {
        return false ? 42 : 99;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("&& with string operands preserves value", async () => {
    await assertEquivalent(
      `export function test(): string {
        const x = "hello";
        const y = "world";
        return (x && y);
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("|| with string operands preserves value", async () => {
    await assertEquivalent(
      `export function test(): string {
        const x = "";
        const y = "fallback";
        return (x || y);
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("&& with mixed types returns correct value", async () => {
    await assertEquivalent(
      `export function test(): any {
        const x = 1;
        const y = "hello";
        return (x && y);
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("|| with mixed types returns correct value", async () => {
    await assertEquivalent(
      `export function test(): any {
        const x = 0;
        const y = "hello";
        return (x || y);
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("ternary with mixed types returns correct branch", async () => {
    await assertEquivalent(
      `export function test(): any {
        const x = true;
        return x ? "yes" : 0;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("&& chain preserves values", async () => {
    await assertEquivalent(
      `export function test(): number {
        return (1 && 2 && 3);
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("|| chain preserves values", async () => {
    await assertEquivalent(
      `export function test(): number {
        return (0 || 0 || 3);
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("void x compared to undefined is true (within wasm)", async () => {
    await assertEquivalent(
      `export function test(): number {
        const x = "hello";
        return (void x === undefined) ? 1 : 0;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("void 0 compared to undefined is true (within wasm)", async () => {
    await assertEquivalent(
      `export function test(): number {
        return (void 0 === undefined) ? 1 : 0;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("?? with null left returns right", async () => {
    await assertEquivalent(
      `export function test(): string {
        const x: string | null = null;
        return x ?? "default";
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("?? with non-null left returns left", async () => {
    await assertEquivalent(
      `export function test(): string {
        const x: string | null = "hello";
        return x ?? "default";
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("&& returns falsy value 0, not false", async () => {
    await assertEquivalent(
      `export function test(): number {
        return (0 && 42);
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("|| returns truthy value, not true", async () => {
    await assertEquivalent(
      `export function test(): number {
        return (42 || 0);
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("isNaN(void x) is true (void produces undefined which is NaN as number)", async () => {
    await assertEquivalent(
      `export function test(): number {
        const x = "hello";
        return isNaN(void x) ? 1 : 0;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("void x in numeric context produces NaN (test262 S11.4.2_A4_T3 pattern)", async () => {
    // Mirrors: isNaN(void x) !== true → should be false (isNaN(void x) IS true)
    await assertEquivalent(
      `export function test(): number {
        const x = "x";
        return isNaN(void x) ? 1 : 0;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("void numeric literal in numeric context produces NaN", async () => {
    await assertEquivalent(
      `export function test(): number {
        return isNaN(void 0) ? 1 : 0;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("&& returns empty string when left is falsy string", async () => {
    await assertEquivalent(
      `export function test(): string {
        const x = "";
        const y = "world";
        return (x && y) as string;
      }`,
      [{ fn: "test", args: [] }],
    );
  });
});
