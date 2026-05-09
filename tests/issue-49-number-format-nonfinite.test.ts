/**
 * #49 — Number.prototype.{toExponential,toPrecision} on non-finite
 * receivers (NaN, Infinity, -Infinity) must skip the fractionDigits /
 * precision range check per ECMA-262 §21.1.3.3 step 3 / §21.1.3.5
 * step 4. Pre-fix, the codegen ran the range check before the receiver-
 * finiteness check, so `(NaN).toExponential(Infinity)` threw RangeError
 * instead of returning the string `"NaN"` per spec.
 *
 * Test262 affected:
 *   - built-ins/Number/prototype/toExponential/{nan,infinity}.js
 *   - built-ins/Number/prototype/toPrecision/{nan,infinity,undefined-precision-arg}.js
 *
 * Fix: codegen now wraps the range check in a `if (isFinite(v)) { ... }`
 * gate. Receiver is saved into an f64 local, finite-check is `(v - v) == 0`
 * (NaN/Infinity give NaN ≠ 0). Runtime helper still short-circuits non-
 * finite v as defense-in-depth.
 *
 * Regression guard: existing #733 RangeError tests (`(1.5).toPrecision(NaN)`
 * still throws; `(1.5).toPrecision(Infinity)` still throws) MUST continue
 * to throw — those have finite receiver + invalid argument. Verified by
 * running tests/issue-733.test.ts.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runFn(source: string, exportName: string): Promise<unknown> {
  const r = compile(source, { fileName: "test.ts" });
  if (!r.success) throw new Error(`compile failed: ${r.errors[0]?.message ?? "?"}`);
  const importResult = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, importResult as any);
  importResult.setExports?.(instance.exports as any);
  return (instance.exports as any)[exportName]();
}

describe("#49 — non-finite receiver skips toExponential/toPrecision range check", () => {
  it("NaN.toExponential(1000) returns 'NaN' (no RangeError despite arg > 100)", async () => {
    const src = `export function r(): string { return (Number.NaN as any).toExponential(1000); }`;
    expect(await runFn(src, "r")).toBe("NaN");
  });

  it("Infinity.toExponential(1000) returns 'Infinity'", async () => {
    const src = `export function r(): string { return (Number.POSITIVE_INFINITY as any).toExponential(1000); }`;
    expect(await runFn(src, "r")).toBe("Infinity");
  });

  it("-Infinity.toExponential(1000) returns '-Infinity'", async () => {
    const src = `export function r(): string { return (Number.NEGATIVE_INFINITY as any).toExponential(1000); }`;
    expect(await runFn(src, "r")).toBe("-Infinity");
  });

  it("NaN.toPrecision(Infinity) returns 'NaN'", async () => {
    const src = `export function r(): string { return (Number.NaN as any).toPrecision(Number.POSITIVE_INFINITY); }`;
    expect(await runFn(src, "r")).toBe("NaN");
  });

  it("Infinity.toPrecision(Infinity) returns 'Infinity'", async () => {
    const src = `export function r(): string { return (Number.POSITIVE_INFINITY as any).toPrecision(Number.POSITIVE_INFINITY); }`;
    expect(await runFn(src, "r")).toBe("Infinity");
  });

  // Regression guard — finite receiver with bad arg STILL throws RangeError
  it("(1.5).toExponential(101) still throws RangeError (finite receiver)", async () => {
    const src = `
      export function r(): number {
        try { (1.5 as any).toExponential(101); return 0; }
        catch (e) { return 1; }
      }
    `;
    expect(await runFn(src, "r")).toBe(1);
  });

  it("(1.5).toPrecision(NaN) still throws RangeError (finite receiver, ToInteger(NaN)=0)", async () => {
    const src = `
      export function r(): number {
        try { (1.5 as any).toPrecision(Number.NaN); return 0; }
        catch (e) { return 1; }
      }
    `;
    expect(await runFn(src, "r")).toBe(1);
  });
});
