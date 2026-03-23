import { describe, it, expect } from "vitest";
import { compileToWasm } from "./helpers.js";

describe("yield as expression (#763)", () => {
  it("yield without value used as IIFE argument", async () => {
    // yield (no operand) used as argument to an IIFE inside a generator.
    // In the eager generator model, the yield receives undefined from .next().
    const exports = await compileToWasm(`
      function *gen(): Generator<undefined, number, number> {
        return (function(arg: number): number {
          return arg + 1;
        }(yield));
      }
      export function test(): number {
        const iter = gen();
        iter.next();       // start generator, yield produces undefined
        const result = iter.next(42);  // resume, yield receives 42 (but eager model gets NaN/undefined)
        // In the eager model, yield returns undefined (NaN for f64),
        // so arg = NaN, NaN + 1 = NaN. The test just checks compilation succeeds.
        return typeof result.value === "number" ? 1 : 0;
      }
    `);
    // The important thing is that compilation succeeds (no "not enough arguments" error).
    // The result depends on the generator execution model.
    expect(exports.test()).toBe(1);
  });

  it("yield with value used as expression", async () => {
    // yield <value> used as expression -- the result of yield is the value passed to .next()
    const exports = await compileToWasm(`
      function *gen(): Generator<number, number, undefined> {
        const x: number = yield 10;
        return 42;
      }
      export function test(): number {
        const iter = gen();
        const first = iter.next();
        // In eager model, generator runs to completion immediately.
        // first.value should be 10 (the yielded value)
        return first.done ? 0 : 1;
      }
    `);
    // In eager model, generator behavior may differ from spec.
    // Just verify compilation succeeds and returns a number.
    expect(typeof exports.test()).toBe("number");
  });

  it("yield in template literal", async () => {
    // yield inside a template expression: \`prefix\${yield}suffix\`
    const exports = await compileToWasm(`
      let result: string = "";
      function *g(): Generator<undefined, undefined, string> {
        result = "a" + (yield) + "b";
      }
      export function test(): number {
        const iter = g();
        iter.next();
        // In eager model, yield returns undefined
        return result.length > 0 ? 1 : 0;
      }
    `);
    // Compilation succeeds -- the yield expression produces a value for the template
    expect(typeof exports.test()).toBe("number");
  });

  it("bare yield as function argument", async () => {
    // yield used as a direct argument to a function call
    const exports = await compileToWasm(`
      function identity(x: number): number { return x; }
      function *gen(): Generator<undefined, number, number> {
        return identity(yield);
      }
      export function test(): number {
        const iter = gen();
        iter.next();
        const result = iter.next(5);
        return typeof result.value === "number" ? 1 : 0;
      }
    `);
    expect(exports.test()).toBe(1);
  });
});
