import { describe, test, expect } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";
import { bodyUsesArguments } from "../src/codegen/helpers/body-uses-arguments.ts";
import ts from "typescript";

async function compileAndRun(src: string): Promise<number> {
  const r = compile(src, { fileName: "test.ts" });
  if (!r.success) {
    throw new Error(`Compile error: ${r.errors[0]?.message}`);
  }
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  return (instance.exports as Record<string, Function>).test() as number;
}

describe("#1085 — bodyUsesArguments iterative walker", () => {
  test("arguments.length works in regular function", async () => {
    expect(
      await compileAndRun(`
      export function test(): number {
        function f(a: number, b: number, c: number) { return arguments.length; }
        return f(1, 2, 3);
      }
    `),
    ).toBe(3);
  });

  test("nested function has own arguments binding", async () => {
    expect(
      await compileAndRun(`
      export function test(): number {
        function outer(a: number, b: number) {
          function inner(x: number) { return arguments.length; }
          return inner(10);
        }
        return outer(1, 2);
      }
    `),
    ).toBe(1);
  });

  test("iterative walker detects arguments in function body", () => {
    const src = `function f() { return arguments.length; }`;
    const sf = ts.createSourceFile("test.ts", src, ts.ScriptTarget.Latest, true);
    const fDecl = sf.statements[0] as ts.FunctionDeclaration;
    // Called on the function body (not SourceFile), arguments is visible
    expect(bodyUsesArguments(fDecl.body!)).toBe(true);
  });

  test("iterative walker skips nested function declarations", () => {
    const src = `function f() { function g() { return arguments.length; } return 0; }`;
    const sf = ts.createSourceFile("test.ts", src, ts.ScriptTarget.Latest, true);
    const fDecl = sf.statements[0] as ts.FunctionDeclaration;
    expect(bodyUsesArguments(fDecl.body!)).toBe(false);
  });

  test("iterative walker traverses arrow functions", () => {
    const src = `const arrow = () => arguments.length;`;
    const sf = ts.createSourceFile("test.ts", src, ts.ScriptTarget.Latest, true);
    expect(bodyUsesArguments(sf)).toBe(true);
  });

  test("no arguments usage detected when absent", () => {
    const src = `function f(x: number) { return x + 1; }`;
    const sf = ts.createSourceFile("test.ts", src, ts.ScriptTarget.Latest, true);
    const fDecl = sf.statements[0] as ts.FunctionDeclaration;
    expect(bodyUsesArguments(fDecl.body!)).toBe(false);
  });

  test("handles deeply nested AST without stack overflow", () => {
    // Generate a deeply nested expression that would blow recursive stack
    let expr = "x";
    for (let i = 0; i < 500; i++) {
      expr = `(${expr} + 1)`;
    }
    const src = `function f(x: number) { return ${expr}; }`;
    const sf = ts.createSourceFile("test.ts", src, ts.ScriptTarget.Latest, true);
    const fDecl = sf.statements[0] as ts.FunctionDeclaration;
    // Should complete without throwing RangeError
    expect(bodyUsesArguments(fDecl.body!)).toBe(false);
  });
});
