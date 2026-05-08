/**
 * Issue #1336 — Object.assign for WasmGC struct sources with accessors / Symbol keys.
 *
 * Per §20.1.2.1 CopyDataProperties, Object.assign must INVOKE getters on the
 * source object (not return descriptors) and must enumerate own enumerable
 * keys including Symbol keys. The host-side `_wrapForHost` proxy used to back
 * WasmGC structs missed both: getter invocation for accessor properties and
 * Symbol keys defined via `_wasmStructAccessors`.
 */
import { describe, expect, it } from "vitest";
import { compileToWasm } from "./equivalence/helpers.ts";

describe("#1336 Object.assign accessor + symbol-key fidelity", () => {
  it("Object.assign copies Symbol-keyed accessor", async () => {
    const src = `
export function test(): number {
  const src: any = {};
  const k: any = Symbol("k");
  Object.defineProperty(src, k, {
    enumerable: true,
    get() {
      return 99;
    },
  });
  const target: any = Object.assign({}, src);
  return target[k] === 99 ? 1 : 0;
}
`;
    const r = await compileToWasm(src);
    expect((r as any).test()).toBe(1);
  });

  it("Object.assign with plain data property (no regression)", async () => {
    const src = `
export function test(): number {
  const src: any = { a: 1, b: 2, c: 3 };
  const target: any = Object.assign({}, src);
  return (target.a as number) + (target.b as number) + (target.c as number);
}
`;
    const r = await compileToWasm(src);
    expect((r as any).test()).toBe(6);
  });
});
