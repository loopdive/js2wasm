import { describe, it, expect } from "vitest";
import { compileToWasm, evaluateAsJs, assertEquivalent, buildImports, compile, readFileSync, resolve } from "./helpers.js";

describe("unary plus coercion (#185)", () => {
  it('+\"\" produces 0', async () => {
    await assertEquivalent(
      `export function test(): number { return +""; }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("+null produces 0", async () => {
    await assertEquivalent(
      `export function test(): number { return +null; }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("+undefined produces NaN", async () => {
    await assertEquivalent(
      `export function test(): number { return +undefined; }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("+true produces 1", async () => {
    await assertEquivalent(
      `export function test(): number { return +true; }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("+false produces 0", async () => {
    await assertEquivalent(
      `export function test(): number { return +false; }`,
      [{ fn: "test", args: [] }],
    );
  });

  it('+\"42\" produces 42', async () => {
    await assertEquivalent(
      `export function test(): number { return +"42"; }`,
      [{ fn: "test", args: [] }],
    );
  });
});
