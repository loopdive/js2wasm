// #1384: Wasm validation failure when an arrow callback's param type
// (resolved to a struct ref) triggers `coerceType` BEFORE the savedFunc swap
// in `compileArrowAsCallback`. The late-import shifter was walking
// `fctx.body` (= cbFctx.body) but not `ctx.currentFunc.body` (the OUTER
// fctx whose body holds the already-emitted `call $userFunc` instruction).
// After my fix, shiftLateImportIndices walks ctx.currentFunc.body too,
// preventing stale funcIdx values that produce CE: "not enough arguments
// on the stack for call".
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function compileAndValidate(src: string) {
  const r = compile(src, { fileName: "test.ts" });
  if (!r.success) throw new Error(`compile failed: ${r.errors[0]?.message}`);
  return WebAssembly.compile(r.binary);
}

describe("#1384 — async chain + arrow callback arity bug", () => {
  it("Promise.all([asyncCall()]).then(r => r) compiles and validates", async () => {
    const src = `
      async function f(): Promise<any> { return 1; }
      export function test(): number {
        Promise.all([f()]).then(r => r);
        return 1;
      }
    `;
    await compileAndValidate(src);
  });

  it("Promise.race + .then with untyped callback compiles", async () => {
    const src = `
      async function f(): Promise<any> { return 1; }
      export function test(): number {
        Promise.race([f()]).then(r => r);
        return 1;
      }
    `;
    await compileAndValidate(src);
  });

  it("class with static async method (PrivateName-style fixture) compiles", async () => {
    // Mirrors the structure of the test262 class-element fixtures (#1384 issue
    // title). The class instantiation + static async dispatch path goes through
    // the same arrow-callback compilation route as the minimum reproducer.
    const src = `
      class C {
        static async f(v: any): Promise<any> { return v; }
      }
      export function test(): number {
        Promise.all([C.f(1)]).then(r => r);
        return 1;
      }
    `;
    await compileAndValidate(src);
  });

  it("nested .then with chained await-shaped values compiles", async () => {
    const src = `
      async function f(): Promise<any> { return 1; }
      async function g(): Promise<any> { return 2; }
      export function test(): number {
        Promise.all([f(), g()]).then(r => r).then(r => r);
        return 1;
      }
    `;
    await compileAndValidate(src);
  });
});
