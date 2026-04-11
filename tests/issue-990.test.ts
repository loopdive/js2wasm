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

describe("issue #990 — yield / await as reserved identifier", () => {
  function hasReservedIdentError(source: string): boolean {
    const r = compile(source);
    return !!r.errors?.some((e) => /reserved word and may not be used as an identifier/.test(e.message));
  }

  it("rejects `var yield` in explicit strict mode", () => {
    expect(hasReservedIdentError(`"use strict";\nvar yield = 1;\n`)).toBe(true);
  });

  it("rejects `yield` as arrow parameter default in strict mode", () => {
    expect(hasReservedIdentError(`"use strict";\n(x = yield) => {};\n`)).toBe(true);
  });

  it("rejects `{ yield }` shorthand in strict-mode function", () => {
    expect(hasReservedIdentError(`var yield = 1;\n(function() { "use strict"; ({ yield }); });\n`)).toBe(true);
  });

  it("rejects `var yield` inside a generator body", () => {
    expect(hasReservedIdentError(`function* gen() { var yield = 1; }\n`)).toBe(true);
  });

  it("rejects `var await` in module goal (top-level)", () => {
    expect(hasReservedIdentError(`var await;\nexport {};\n`)).toBe(true);
  });

  it("rejects `var await` inside an async function", () => {
    expect(hasReservedIdentError(`async function f() { var await = 1; }\n`)).toBe(true);
  });

  it("allows `yield` as property name", () => {
    expect(hasReservedIdentError(`"use strict";\nvar o = { yield: 1 };\no.yield;\n`)).toBe(false);
  });

  it("allows `await` as property name in module code", () => {
    expect(hasReservedIdentError(`var o = { await: 1 }; o.await;\nexport {};\n`)).toBe(false);
  });

  it("allows `yield` as identifier in sloppy-mode script", () => {
    // No "use strict", no module, not a generator — yield is a valid identifier.
    expect(hasReservedIdentError(`var yield = 1; yield;\n`)).toBe(false);
  });

  it("does not flag inside wrapTest sentinel", () => {
    const wrapped = `
      export function test(): number {
        var yield = 1;
        return 1;
      }
    `;
    expect(hasReservedIdentError(wrapped)).toBe(false);
  });
});
