import { describe, it, expect } from "vitest";
import { compileToWasm, evaluateAsJs, assertEquivalent, buildImports, compile, readFileSync, resolve } from "./helpers.js";

describe("coalesce operator type unification (#193)", () => {
  it("null string ?? default returns default", async () => {
    await assertEquivalent(
      `export function test(): string {
        const x: string | null = null;
        return x ?? "default";
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("non-null string ?? fallback returns original", async () => {
    await assertEquivalent(
      `export function test(): string {
        const x: string | null = "hello";
        return x ?? "default";
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("undefined string ?? default returns default", async () => {
    await assertEquivalent(
      `export function test(): string {
        const x: string | undefined = undefined;
        return x ?? "default";
      }`,
      [{ fn: "test", args: [] }],
    );
  });
});
