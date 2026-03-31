import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildStringConstants } from "../src/runtime.js";

async function run(source: string, fn: string, args: unknown[] = []): Promise<unknown> {
  const result = compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
  const env: Record<string, Function> = {};
  const jsStringPolyfill = {
    concat: (a: string, b: string) => a + b,
    length: (s: string) => s.length,
    equals: (a: string, b: string) => (a === b ? 1 : 0),
    substring: (s: string, start: number, end: number) => s.substring(start, end),
    charCodeAt: (s: string, i: number) => s.charCodeAt(i),
  };
  const { instance } = await WebAssembly.instantiate(result.binary, {
    env,
    "wasm:js-string": jsStringPolyfill,
    string_constants: buildStringConstants(result.stringPool),
  } as WebAssembly.Imports);
  return (instance.exports as any)[fn](...args);
}

describe("illegal cast - closures from different scopes (#585)", () => {
  it("closure assigned from different factory calls", async () => {
    const result = await run(
      `
      function makeAdder(x: number) {
        return function(y: number): number { return x + y; };
      }
      const add5 = makeAdder(5);
      const add10 = makeAdder(10);
      export function test(): number {
        let fn = add5;
        let r1 = fn(3);
        fn = add10;
        let r2 = fn(3);
        return r1 * 100 + r2;
      }
    `,
      "test",
    );
    expect(result).toBe(813);
  });

  it("higher-order function returning closures with mutable captures", async () => {
    const result = await run(
      `
      function makeCounter(start: number) {
        let count = start;
        return function(): number {
          count = count + 1;
          return count;
        };
      }
      const c1 = makeCounter(0);
      const c2 = makeCounter(100);
      export function test(): number {
        let r1 = c1();
        let r2 = c2();
        let r3 = c1();
        return r1 * 10000 + r2 * 10 + r3;
      }
    `,
      "test",
    );
    expect(result).toBe(10000 + 1010 + 2);
  });

  it("closure returned from call expression invoked immediately - fn()()", async () => {
    const result = await run(
      `
      function makeMultiplier(x: number) {
        return function(y: number): number { return x * y; };
      }
      export function test(): number {
        return makeMultiplier(3)(7);
      }
    `,
      "test",
    );
    expect(result).toBe(21);
  });

  it("class method with default parameter creating closure (scope-paramsbody pattern)", async () => {
    // This pattern matches the test262 scope-meth-paramsbody-var-close pattern
    const result = await run(
      `
      let probe: () => number;
      class C {
        m(_: number = 0): void {
          let x: number = 42;
          probe = function(): number { return x; };
        }
      }
      export function test(): number {
        const c = new C();
        c.m();
        return probe();
      }
    `,
      "test",
    );
    expect(result).toBe(42);
  });

  it("closure with non-void return passed to void-expecting parameter (#585 core fix)", async () => {
    // This is the exact pattern that caused illegal cast in test262:
    // A closure returning externref passed to a function expecting () => void.
    // The contextual type override ensures the wrapper struct matches.
    const result = await run(
      `
      function doCall(fn: () => void): number {
        fn();
        return 1;
      }
      class C {
        val(): number { return 42; }
        run(): number {
          return doCall(() => this.val());
        }
      }
      export function test(): number {
        const c = new C();
        return c.run();
      }
    `,
      "test",
    );
    expect(result).toBe(1);
  });

  it("assert_throws pattern with capturing closure (#585)", async () => {
    // Pattern from test262 compound-assignment tests:
    // assert_throws(() => obj.method()) where the lambda captures obj
    const result = await run(
      `
      function assertThrows(fn: () => void): number {
        try {
          fn();
          return 0;
        } catch (e) {
          return 1;
        }
      }
      class C {
        val: number = 10;
        doSomething(): number {
          return this.val + 1;
        }
      }
      export function test(): number {
        const o = new C();
        return assertThrows(() => o.doSomething());
      }
    `,
      "test",
    );
    // doSomething doesn't throw, so assertThrows returns 0
    expect(result).toBe(0);
  });

  it("class expression with name scope (class expr name binding)", async () => {
    // Matches test262 scope-name-lex-close pattern
    const result = await run(
      `
      export function test(): number {
        let result = 0;
        const cls = class MyClass {
          getVal(): number {
            return 99;
          }
        };
        const obj = new cls();
        result = obj.getVal();
        return result;
      }
    `,
      "test",
    );
    expect(result).toBe(99);
  });
});
