/**
 * Issue #1362 — Object.defineProperties spec fixes.
 *
 * §20.1.2.3 (Object.defineProperties):
 *   - Step 2: ToObject(Properties) throws TypeError on null/undefined.
 *   - Step 3: Iterate [[OwnPropertyKeys]] — includes Symbol keys.
 *
 * Previous host impl silently returned obj for null/undefined Properties
 * and only iterated `Object.keys` (string keys).
 */
import { describe, expect, it } from "vitest";
import { compileToWasm } from "./equivalence/helpers.ts";

describe("#1362 Object.defineProperties spec gaps", () => {
  it("throws TypeError when Properties is undefined", async () => {
    const src = `
export function test(): number {
  const o: any = {};
  try {
    Object.defineProperties(o, undefined as any);
    return 0;
  } catch (e) {
    return e instanceof TypeError ? 1 : 2;
  }
}
`;
    const r = await compileToWasm(src);
    expect((r as any).test()).toBe(1);
  });

  it("throws TypeError when Properties is null", async () => {
    const src = `
export function test(): number {
  const o: any = {};
  try {
    Object.defineProperties(o, null as any);
    return 0;
  } catch (e) {
    return e instanceof TypeError ? 1 : 2;
  }
}
`;
    const r = await compileToWasm(src);
    expect((r as any).test()).toBe(1);
  });

  it("throws TypeError when target is null", async () => {
    const src = `
export function test(): number {
  try {
    Object.defineProperties(null as any, { x: { value: 1 } });
    return 0;
  } catch (e) {
    return e instanceof TypeError ? 1 : 2;
  }
}
`;
    const r = await compileToWasm(src);
    expect((r as any).test()).toBe(1);
  });

  it("applies multiple data descriptors (no regression)", async () => {
    const src = `
export function test(): number {
  const o: any = {};
  Object.defineProperties(o, {
    a: { value: 1, enumerable: true, writable: true, configurable: true },
    b: { value: 2, enumerable: true, writable: true, configurable: true },
  });
  return (o.a as number) + (o.b as number);
}
`;
    const r = await compileToWasm(src);
    expect((r as any).test()).toBe(3);
  });
});
