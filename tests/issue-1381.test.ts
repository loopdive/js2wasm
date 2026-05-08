/**
 * Issue #1381 (slice B): String.prototype.lastIndexOf — pad missing
 * fromIndex with JS `undefined` (not `null`) so the host sees the
 * spec-correct "not passed" semantics. Per §22.1.3.10 step 4: when
 * fromIndex is undefined, the spec uses +Infinity (clamped to length).
 *
 * Previous behaviour: missing externref args were padded with
 * `ref.null.extern`. JS `"abcabc".lastIndexOf("a", null)` calls
 * ToInteger(null)=0 ⇒ search range up to and including index 0 only ⇒
 * returns 0 instead of the correct 3.
 */
import { describe, expect, it } from "vitest";
import { compileToWasm } from "./equivalence/helpers.ts";

describe("#1381 String.prototype.lastIndexOf default fromIndex", () => {
  it("lastIndexOf with no fromIndex defaults to +Infinity (returns last match)", async () => {
    const src = `
export function test(): number {
  // "abcabc".lastIndexOf("a") — last 'a' is at index 3 (not 0).
  return "abcabc".lastIndexOf("a");
}
`;
    const r = await compileToWasm(src);
    expect((r as any).test()).toBe(3);
  });

  it("lastIndexOf with explicit fromIndex still works (no regression)", async () => {
    const src = `
export function test(): number {
  // "abcabc".lastIndexOf("a", 2) — last 'a' at or before index 2 is at index 0.
  return "abcabc".lastIndexOf("a", 2);
}
`;
    const r = await compileToWasm(src);
    expect((r as any).test()).toBe(0);
  });

  it("lastIndexOf with not-found search returns -1", async () => {
    const src = `
export function test(): number {
  return "abcabc".lastIndexOf("z");
}
`;
    const r = await compileToWasm(src);
    expect((r as any).test()).toBe(-1);
  });

  it("indexOf with no fromIndex still works (no regression)", async () => {
    const src = `
export function test(): number {
  return "abcabc".indexOf("a");
}
`;
    const r = await compileToWasm(src);
    expect((r as any).test()).toBe(0);
  });
});
