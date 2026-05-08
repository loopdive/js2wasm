/**
 * Issue #1342 — JSON.stringify replacer-function bridge.
 *
 * §25.5.2.1 step 3a: when `replacer` is a Function it is invoked for each
 * (key, value) pair before the value is serialised. WasmGC closures cross
 * the JS boundary as `typeof === "object"`, so host JSON.stringify silently
 * ignored them. Bridge them through `__call_fn_2` so the closure runs as
 * a JS function during stringification.
 */
import { describe, expect, it } from "vitest";
import { compileToWasm } from "./equivalence/helpers.ts";

describe("#1342 JSON.stringify replacer", () => {
  it("function replacer transforms numeric values", async () => {
    const src = `
export function test(): string {
  const obj: any = { a: 1, b: 2, c: 3 };
  return JSON.stringify(obj, (key, value) => {
    if (typeof value === "number") return value * 2;
    return value;
  });
}
`;
    const r = await compileToWasm(src);
    expect((r as any).test()).toBe('{"a":2,"b":4,"c":6}');
  });

  it("function replacer can drop properties (return undefined)", async () => {
    const src = `
export function test(): string {
  const obj: any = { keep: "yes", drop: "no" };
  return JSON.stringify(obj, (key, value) => {
    if (key === "drop") return undefined;
    return value;
  });
}
`;
    const r = await compileToWasm(src);
    expect((r as any).test()).toBe('{"keep":"yes"}');
  });

  it("no replacer (no regression)", async () => {
    const src = `
export function test(): string {
  return JSON.stringify({ a: 1, b: "two" });
}
`;
    const r = await compileToWasm(src);
    expect((r as any).test()).toBe('{"a":1,"b":"two"}');
  });
});
