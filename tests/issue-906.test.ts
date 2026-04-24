/**
 * Issue #906: Compile away TDZ tracking for definite-assignment top-level
 * let/const variables.
 *
 * When every read of a top-level let/const can be statically proven to be
 * after its initializer, the compiler should drop the `__tdz_<name>` global,
 * the `global.set __tdz_<name>` write in `__module_init`, and the runtime
 * TDZ check at every read.
 *
 * Genuinely dynamic / ambiguous cases (e.g. a hoisted function declaration
 * that reads the variable, since it could be called before the variable's
 * initializer runs) must keep TDZ tracking.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

async function run(src: string): Promise<number> {
  const r = compile(src, { fileName: "test.ts" });
  if (!r.success) throw new Error(`CE: ${r.errors[0]?.message}`);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  return (instance.exports.test as () => number)();
}

function compileWat(src: string): string {
  const r = compile(src, { fileName: "test.ts" });
  if (!r.success) throw new Error(`CE: ${r.errors[0]?.message}`);
  return r.wat;
}

describe("Issue #906: TDZ elision for top-level definite-assignment let/const", () => {
  it("issue example: top-level let result, loop body assigns, console.log reads — no __tdz_result", () => {
    const wat = compileWat(`
      function squared(n: number): number { return n * n; }
      let result = 0;
      for (let i = 0; i < 10000; i++) {
        result += squared(10);
      }
      console.log(result);
    `);
    expect(wat).not.toContain("__tdz_result");
    // Sanity: the value global is still there.
    expect(wat).toContain("__mod_result");
  });

  it("issue example runs end-to-end with correct value", async () => {
    // Using a wrapper called after init — note: this case will keep the TDZ
    // tracking because `test` is a hoisted function. We just validate the
    // resulting binary is correct.
    const result = await run(`
      function squared(n: number): number { return n * n; }
      let result = 0;
      for (let i = 0; i < 10000; i++) {
        result += squared(10);
      }
      export function test(): number { return result; }
    `);
    expect(result).toBe(1_000_000);
  });

  it("simple top-level const with straight-line use — no __tdz_x", () => {
    const wat = compileWat(`
      const x: number = 42;
      console.log(x);
    `);
    expect(wat).not.toContain("__tdz_x");
  });

  it("multiple top-level let/const all definite-assigned — no __tdz_* globals", () => {
    const wat = compileWat(`
      let a = 1;
      let b = 2;
      const c = a + b;
      console.log(c);
    `);
    expect(wat).not.toContain("__tdz_a");
    expect(wat).not.toContain("__tdz_b");
    expect(wat).not.toContain("__tdz_c");
  });

  it("module-level let read inside hoisted function declaration — preserves TDZ", () => {
    // Function declarations are hoisted; they could be called before the
    // variable's initializer runs. analyzeTdzAccess returns "check" for
    // function-declaration access, so we conservatively keep TDZ tracking.
    const wat = compileWat(`
      export function getResult(): number { return result; }
      let result: number = 42;
    `);
    expect(wat).toContain("__tdz_result");
  });

  it("forward reference inside hoisted function — preserves TDZ", () => {
    const wat = compileWat(`
      function early(): number { return result; }
      const before: number = early();
      let result: number = 42;
    `);
    expect(wat).toContain("__tdz_result");
  });

  it("arrow function captured before init — preserves TDZ", () => {
    // The arrow function definition is at position before `let x = 0;`,
    // so the closure-deferred-call optimization in analyzeTdzAccess won't
    // apply (closureStart < declEnd) — the result is "check", not "skip".
    const wat = compileWat(`
      let cb: () => number = () => x;
      let x = 0;
      cb();
    `);
    // cb captures x before x is initialized. TDZ tracking must remain.
    expect(wat).toContain("__tdz_x");
  });

  it("arrow function defined after init reads safely — TDZ elided", () => {
    const wat = compileWat(`
      let x = 42;
      const f = () => x;
      console.log(f());
    `);
    // x's only references are: f's body (closureStart > declEnd, not in
    // loop containing decl) and the call inside console.log.
    expect(wat).not.toContain("__tdz_x");
  });

  it("read inside a for-loop that does not contain the declaration — TDZ elided", () => {
    const wat = compileWat(`
      let total = 0;
      for (let i = 0; i < 5; i++) {
        total = total + i;
      }
      console.log(total);
    `);
    // The for loop contains reads of `total` but does NOT contain the decl
    // of `total`, so isInsideLoopContaining returns false → "skip".
    expect(wat).not.toContain("__tdz_total");
  });

  it("definite-assigned let unused after init — no __tdz_unused", () => {
    const wat = compileWat(`
      let unused = 5;
      console.log("ok");
    `);
    expect(wat).not.toContain("__tdz_unused");
  });

  it("end-to-end: top-level loop with elided TDZ yields correct sum", async () => {
    const result = await run(`
      let sum = 0;
      for (let i = 1; i <= 100; i++) {
        sum += i;
      }
      export function test(): number { return sum; }
    `);
    expect(result).toBe(5050);
  });
});
