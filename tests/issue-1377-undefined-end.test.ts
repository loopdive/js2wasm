import { describe, it, expect } from "vitest";
import { compile } from "./src/index.js";
import { buildImports } from "./src/runtime.js";

describe("#1377 — fill/copyWithin: undefined end argument defaults to length (spec §23.1.3.{4,7})", () => {
  async function runTest(src: string): Promise<{ pass: boolean; ret?: unknown; error?: string }> {
    const result = compile(src, { skipSemanticDiagnostics: true });
    if (!result.success) return { pass: false, error: result.error };
    const importObj = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, importObj as any);
    if (typeof (importObj as any).setExports === "function") {
      (importObj as any).setExports(instance.exports);
    }
    try {
      const ret = (instance.exports as any).test();
      return { pass: ret === 1, ret };
    } catch (e: any) {
      return { pass: false, error: String(e) };
    }
  }

  it("Array.prototype.fill(value, start, undefined) treats end as length (full fill)", async () => {
    const src = `
      export function test(): number {
        const a = [0, 0];
        a.fill(1, 0, undefined);
        return a[0] === 1 && a[1] === 1 ? 1 : 0;
      }
    `;
    const { pass, error } = await runTest(src);
    expect(error).toBeUndefined();
    expect(pass).toBe(true);
  });

  it("Array.prototype.fill(value, undefined, undefined) — both undefined: full fill", async () => {
    const src = `
      export function test(): number {
        const a = [0, 0];
        a.fill(1, undefined, undefined);
        return a[0] === 1 && a[1] === 1 ? 1 : 0;
      }
    `;
    const { pass, error } = await runTest(src);
    expect(error).toBeUndefined();
    expect(pass).toBe(true);
  });

  it("Array.prototype.fill(value, 0, NaN) — NaN end is still 0 (no fill)", async () => {
    // Spec: ToIntegerOrInfinity(NaN) = 0, so end=0 → fill nothing.
    // This must NOT regress when we special-case undefined.
    const src = `
      export function test(): number {
        const a = [0, 0];
        a.fill(1, 0, NaN);
        return a[0] === 0 && a[1] === 0 ? 1 : 0;
      }
    `;
    const { pass, error } = await runTest(src);
    expect(error).toBeUndefined();
    expect(pass).toBe(true);
  });

  it("Array.prototype.fill(value, 0, void 0) — void expression also treated as undefined", async () => {
    const src = `
      export function test(): number {
        const a = [0, 0];
        a.fill(1, 0, void 0);
        return a[0] === 1 && a[1] === 1 ? 1 : 0;
      }
    `;
    const { pass, error } = await runTest(src);
    expect(error).toBeUndefined();
    expect(pass).toBe(true);
  });

  it("Array.prototype.copyWithin(target, start, undefined) — end defaults to length", async () => {
    const src = `
      export function test(): number {
        const a = [0, 1, 2, 3];
        a.copyWithin(1, 0, undefined);
        // Expected: [0, 0, 1, 2] (full copy from index 0, count = min(4, 3) = 3)
        return a[0] === 0 && a[1] === 0 && a[2] === 1 && a[3] === 2 ? 1 : 0;
      }
    `;
    const { pass, error } = await runTest(src);
    expect(error).toBeUndefined();
    expect(pass).toBe(true);
  });

  it("Array.prototype.copyWithin(target, start, NaN) — NaN end is still 0 (no copy)", async () => {
    const src = `
      export function test(): number {
        const a = [0, 1, 2, 3];
        a.copyWithin(1, 0, NaN);
        // Expected: [0, 1, 2, 3] (end=0 → no copy)
        return a[0] === 0 && a[1] === 1 && a[2] === 2 && a[3] === 3 ? 1 : 0;
      }
    `;
    const { pass, error } = await runTest(src);
    expect(error).toBeUndefined();
    expect(pass).toBe(true);
  });

  it("Array.prototype.copyWithin(target, start, void 0) — void expression also treated as undefined", async () => {
    const src = `
      export function test(): number {
        const a = [0, 1, 2, 3];
        a.copyWithin(1, 0, void 0);
        return a[0] === 0 && a[1] === 0 && a[2] === 1 && a[3] === 2 ? 1 : 0;
      }
    `;
    const { pass, error } = await runTest(src);
    expect(error).toBeUndefined();
    expect(pass).toBe(true);
  });

  it("fill: existing semantics preserved — null/false coerce to 0 (no regression)", async () => {
    const src = `
      export function test(): number {
        const a = [0, 0];
        a.fill(1, 0, null as any);
        // null → 0 → no fill
        return a[0] === 0 && a[1] === 0 ? 1 : 0;
      }
    `;
    const { pass, error } = await runTest(src);
    expect(error).toBeUndefined();
    expect(pass).toBe(true);
  });

  it("copyWithin: existing semantics preserved — true coerces to 1", async () => {
    const src = `
      export function test(): number {
        const a = [0, 1, 2, 3];
        a.copyWithin(1, 0, true as any);
        // true → 1 → copy 1 element from idx 0 to idx 1: [0, 0, 2, 3]
        return a[0] === 0 && a[1] === 0 && a[2] === 2 && a[3] === 3 ? 1 : 0;
      }
    `;
    const { pass, error } = await runTest(src);
    expect(error).toBeUndefined();
    expect(pass).toBe(true);
  });
});
