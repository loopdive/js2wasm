// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1321 — Number.prototype formatting: fix radix-ignored bug + toPrecision() no-arg crash.
//
// Pre-fix bugs:
//   1. `(value).toString(radix)` silently ignored the radix argument — the codegen
//      validated the radix range (correctly throwing RangeError for out-of-range)
//      but then called the 1-arg `number_toString(value)` host import, which uses
//      `String(v)` (always base 10). So `(255).toString(16)` returned `"255"`
//      instead of `"ff"`.
//   2. `(value).toPrecision()` (no args) crashed at Wasm validation time:
//      `not enough arguments on the stack for call (need 2, got 1)` — the codegen
//      tried to fall through to `number_toString` which wasn't always registered,
//      then called the 2-arg `number_toPrecision` with only one operand.
//
// Fix:
//   - Add a 2-arg host import `number_toString_radix(value, radix)` and route
//     `value.toString(radix)` to it when a radix arg is present. Keep the 1-arg
//     `number_toString` for the no-radix case (no behaviour change there).
//   - Push `f64.const NaN` as the second arg to `number_toPrecision` when the
//     call has no precision argument, mirroring the existing toExponential
//     pattern. Update the host runtime to recognise NaN as the "no precision"
//     sentinel and return `String(v)` (≡ `toString()`).
//
// Note: this is a JS-host-mode fix. The standalone (no-host) story for these
// methods is tracked in #1335 (pure-Wasm Ryu / integer base-N).

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function compileAndCall(src: string, fnName: string): Promise<unknown> {
  const r = compile(src, { fileName: "test.ts" });
  if (!r.success || r.errors.some((e) => e.severity === "error")) {
    const errs = r.errors
      .filter((e) => e.severity === "error")
      .map((e) => `L${e.line}:${e.column} ${e.message}`)
      .join(" | ");
    throw new Error(`compile failed: ${errs}`);
  }
  const env = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, env);
  const fn = (instance.exports as Record<string, () => unknown>)[fnName];
  return fn?.();
}

describe("#1321 Number.prototype formatting", () => {
  describe("toString(radix) — radix is now actually used (was previously dropped)", () => {
    it("(255).toString(16) === 'ff'", async () => {
      const out = await compileAndCall(`export function f(): string { return (255).toString(16); }`, "f");
      expect(out).toBe("ff");
    });

    it("(255).toString(2) === '11111111'", async () => {
      const out = await compileAndCall(`export function f(): string { return (255).toString(2); }`, "f");
      expect(out).toBe("11111111");
    });

    it("(255).toString(8) === '377'", async () => {
      const out = await compileAndCall(`export function f(): string { return (255).toString(8); }`, "f");
      expect(out).toBe("377");
    });

    it("(35).toString(36) === 'z' (max valid radix)", async () => {
      const out = await compileAndCall(`export function f(): string { return (35).toString(36); }`, "f");
      expect(out).toBe("z");
    });

    it("(255).toString(10) === '255'", async () => {
      const out = await compileAndCall(`export function f(): string { return (255).toString(10); }`, "f");
      expect(out).toBe("255");
    });

    it("(-255).toString(16) === '-ff'", async () => {
      const out = await compileAndCall(`export function f(): string { return (-255).toString(16); }`, "f");
      expect(out).toBe("-ff");
    });
  });

  describe("toString() — no-arg path unchanged", () => {
    it("(255).toString() === '255'", async () => {
      const out = await compileAndCall(`export function f(): string { return (255).toString(); }`, "f");
      expect(out).toBe("255");
    });

    it("(3.14).toString() === '3.14'", async () => {
      const out = await compileAndCall(`export function f(): string { return (3.14).toString(); }`, "f");
      expect(out).toBe("3.14");
    });
  });

  describe("toString(radix) — special values", () => {
    it("NaN.toString(16) === 'NaN'", async () => {
      const out = await compileAndCall(`export function f(): string { return NaN.toString(16); }`, "f");
      expect(out).toBe("NaN");
    });

    it("Infinity.toString(2) === 'Infinity'", async () => {
      const out = await compileAndCall(`export function f(): string { return Infinity.toString(2); }`, "f");
      expect(out).toBe("Infinity");
    });

    it("(-Infinity).toString(16) === '-Infinity'", async () => {
      const out = await compileAndCall(`export function f(): string { return (-Infinity).toString(16); }`, "f");
      expect(out).toBe("-Infinity");
    });

    it("(-0).toString() === '0'", async () => {
      const out = await compileAndCall(`export function f(): string { return (-0).toString(); }`, "f");
      expect(out).toBe("0");
    });
  });

  describe("toString(radix) — RangeError for out-of-range radix", () => {
    it("toString(1) throws RangeError", async () => {
      const r = compile(`export function f(): string { return (5).toString(1); }`, { fileName: "test.ts" });
      const env = buildImports(r.imports, undefined, r.stringPool);
      const { instance } = await WebAssembly.instantiate(r.binary, env);
      expect(() => (instance.exports as { f: () => unknown }).f()).toThrow();
    });

    it("toString(37) throws RangeError", async () => {
      const r = compile(`export function f(): string { return (5).toString(37); }`, { fileName: "test.ts" });
      const env = buildImports(r.imports, undefined, r.stringPool);
      const { instance } = await WebAssembly.instantiate(r.binary, env);
      expect(() => (instance.exports as { f: () => unknown }).f()).toThrow();
    });
  });

  describe("toPrecision() — no-arg no longer crashes Wasm validation", () => {
    it("(123.456).toPrecision() returns '123.456' without crashing", async () => {
      const out = await compileAndCall(`export function f(): string { return (123.456).toPrecision(); }`, "f");
      expect(out).toBe("123.456");
    });

    it("(0).toPrecision() returns '0'", async () => {
      const out = await compileAndCall(`export function f(): string { return (0).toPrecision(); }`, "f");
      expect(out).toBe("0");
    });

    it("NaN.toPrecision() returns 'NaN'", async () => {
      const out = await compileAndCall(`export function f(): string { return NaN.toPrecision(); }`, "f");
      expect(out).toBe("NaN");
    });
  });

  describe("regressions — toFixed/toPrecision/toExponential still work", () => {
    it("(3.14).toFixed(2) === '3.14'", async () => {
      const out = await compileAndCall(`export function f(): string { return (3.14).toFixed(2); }`, "f");
      expect(out).toBe("3.14");
    });

    it("(123.456).toPrecision(5) === '123.46'", async () => {
      const out = await compileAndCall(`export function f(): string { return (123.456).toPrecision(5); }`, "f");
      expect(out).toBe("123.46");
    });

    it("(0.000123).toExponential(2) === '1.23e-4'", async () => {
      const out = await compileAndCall(`export function f(): string { return (0.000123).toExponential(2); }`, "f");
      expect(out).toBe("1.23e-4");
    });
  });
});
