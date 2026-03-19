import { describe, test, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function compileAndRun(code: string) {
  const result = compile(code);
  for (const e of result.errors) {
    if (e.severity === "error") console.log(`  Error: ${e.message} (line ${e.line})`);
  }
  if (result.errors.some(e => e.severity === "error")) {
    throw new Error(`Got compile errors`);
  }
  const imports = buildImports(result.imports ?? [], {}, result.stringPool ?? []);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  const main = instance.exports.main as Function;
  return main();
}

describe("issue-530: unsupported call expression fixes", () => {
  test("union type method call compiles and runs", async () => {
    expect(await compileAndRun(`
      class A { value(): number { return 1; } }
      class B { value(): number { return 2; } }
      export function main(): number {
        const x: A | B = new A();
        return x.value();
      }
    `)).toBe(1);
  });

  test("this.method() calls within class", async () => {
    expect(await compileAndRun(`
      class Foo {
        getValue(): number { return 42; }
        getDouble(): number { return this.getValue() * 2; }
      }
      export function main(): number {
        const f = new Foo();
        return f.getDouble();
      }
    `)).toBe(84);
  });

  test("abstract class method call no unsupported error", () => {
    const result = compile(`
      abstract class Base { abstract get(): number; }
      class Derived extends Base { get(): number { return 42; } }
      export function main(): number {
        const b: Base = new Derived();
        return b.get();
      }
    `);
    const unsupported = result.errors.filter(e => e.message.includes("Unsupported call"));
    expect(unsupported).toHaveLength(0);
  });

  test("interface method call no unsupported error", () => {
    const result = compile(`
      interface HasValue { getValue(): number; }
      class Impl implements HasValue { getValue(): number { return 42; } }
      function callIt(obj: HasValue): number { return obj.getValue(); }
      export function main(): number {
        return callIt(new Impl());
      }
    `);
    const unsupported = result.errors.filter(e => e.message.includes("Unsupported call"));
    expect(unsupported).toHaveLength(0);
  });

  test("String.prototype.method.call no unsupported error", () => {
    const result = compile(`
      export function main(): string {
        const a = "hello".slice(0, 2);
        return String.prototype.slice.call("world", 0, 3);
      }
    `);
    const unsupported = result.errors.filter(e => e.message.includes("Unsupported call"));
    expect(unsupported).toHaveLength(0);
  });

  test("Promise.then no unsupported error", () => {
    const result = compile(`
      export function main(): void {
        Promise.resolve(1).then((v: number) => { });
      }
    `);
    const unsupported = result.errors.filter(e => e.message.includes("Unsupported call"));
    expect(unsupported).toHaveLength(0);
  });
});
