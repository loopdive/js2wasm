import { describe, it, expect } from "vitest";
import {
  compileToWasm,
  evaluateAsJs,
  assertEquivalent,
  buildImports,
  compile,
  readFileSync,
  resolve,
} from "./helpers.js";

describe("negative zero modulus (#175)", () => {
  it("-1 % -1 produces -0", async () => {
    await assertEquivalent(`export function test(): number { return 1 / (-1 % -1); }`, [{ fn: "test", args: [] }]);
  });

  it("(-1) % 1 produces -0", async () => {
    await assertEquivalent(`export function test(): number { return 1 / ((-1) % 1); }`, [{ fn: "test", args: [] }]);
  });

  it("7 % 3 produces 1 (positive case unchanged)", async () => {
    await assertEquivalent(`export function test(): number { return 7 % 3; }`, [{ fn: "test", args: [] }]);
  });
});
