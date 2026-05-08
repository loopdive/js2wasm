import { describe, it, expect } from "vitest";
import { compile } from "./src/index.js";

describe("#1389 — false CE: var + function-decl same name at top-level", () => {
  it("var + function-decl at SourceFile scope compiles (script-level: var-scoped)", () => {
    const src = `
      var smoosh;
      function smoosh() {}
      export function test(): number {
        return typeof smoosh === "function" ? 1 : 0;
      }
    `;
    const result = compile(src, { skipSemanticDiagnostics: true });
    expect(result.success).toBe(true);
  });

  it("function-decl + var at SourceFile scope (other order) also compiles", () => {
    const src = `
      function smoosh() {}
      var smoosh;
      export function test(): number {
        return 1;
      }
    `;
    const result = compile(src, { skipSemanticDiagnostics: true });
    expect(result.success).toBe(true);
  });

  it("let + var at SourceFile scope STILL errors (let is genuinely lexical)", () => {
    const src = `
      let smoosh;
      var smoosh;
      export function test(): number { return 1; }
    `;
    const result = compile(src, { skipSemanticDiagnostics: true });
    expect(result.success).toBe(false);
  });

  it("class + var at SourceFile scope STILL errors (class is lexical)", () => {
    const src = `
      class Smoosh {}
      var Smoosh;
      export function test(): number { return 1; }
    `;
    const result = compile(src, { skipSemanticDiagnostics: true });
    expect(result.success).toBe(false);
  });

  it("function + var inside a Block STILL errors (block-scoped function is lexical)", () => {
    // Block-scoped function declaration (ES §B.3.2) — lexically scoped.
    const src = `
      export function test(): number {
        {
          function x() {}
          var x = 2;
        }
        return 1;
      }
    `;
    const result = compile(src, { skipSemanticDiagnostics: true });
    expect(result.success).toBe(false);
  });

  it("let + var inside a Block STILL errors", () => {
    const src = `
      export function test(): number {
        {
          let x = 1;
          var x = 2;
        }
        return 1;
      }
    `;
    const result = compile(src, { skipSemanticDiagnostics: true });
    expect(result.success).toBe(false);
  });
});
