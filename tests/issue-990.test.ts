import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

function compileFail(source: string): boolean {
  const r = compile(source);
  return !r.success || r.errors.some((e) => e.severity === "error");
}

describe("issue #990 — module item position early errors", () => {
  it("rejects export default nested in while", () => {
    expect(compileFail(`while (false) export default null;\nexport {};\n`)).toBe(true);
  });

  it("rejects import nested in try/finally", () => {
    expect(compileFail(`try {} catch (e) {} finally { import v from "./x.js"; }\nexport {};\n`)).toBe(true);
  });

  it("rejects export default inside class method", () => {
    expect(compileFail(`(class { method() { export default 1; } });\nexport {};\n`)).toBe(true);
  });

  it("rejects import inside for-of", () => {
    expect(compileFail(`for (const x of []) import v from "./x.js";\nexport {};\n`)).toBe(true);
  });

  it("rejects export nested in block statement", () => {
    expect(compileFail(`{ export { x }; }\nvar x = 1;\nexport {};\n`)).toBe(true);
  });

  it("does not flag top-level export at module top level", () => {
    const r = compile(`export const x: number = 1;\n`);
    // May or may not have unrelated errors, but must NOT contain our message.
    const hit = r.errors?.some((e) => /declarations may only appear at the top level/.test(e.message));
    expect(hit).toBe(false);
  });

  it("does not flag nested export inside wrapTest-style test wrapper", () => {
    // wrapTest sentinel — `export function test(): number` at top level
    // suppresses the check so positive tests aren't regressed.
    const wrapped = `
      export function test(): number {
        // in the original source this would be top-level
        return 1;
      }
    `;
    const r = compile(wrapped);
    const hit = r.errors?.some((e) => /declarations may only appear at the top level/.test(e.message));
    expect(hit).toBe(false);
  });
});
