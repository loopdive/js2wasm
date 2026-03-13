import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(source: string, fn: string, args: unknown[] = []): Promise<unknown> {
  const result = compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(
    result.binary,
    imports as unknown as WebAssembly.Imports,
  );
  return (instance.exports as any)[fn](...args);
}

describe("instanceof operator (#188)", { timeout: 15000 }, () => {
  it("any-typed variable: positive match", async () => {
    expect(
      await run(
        `
      class Foo { x: number; constructor() { this.x = 1; } }
      export function test(): number {
        let obj: any = new Foo();
        return obj instanceof Foo ? 1 : 0;
      }
    `,
        "test",
      ),
    ).toBe(1);
  });

  it("any-typed variable: negative match (different class)", async () => {
    expect(
      await run(
        `
      class Foo { x: number; constructor() { this.x = 1; } }
      class Bar { y: number; constructor() { this.y = 2; } }
      export function test(): number {
        let obj: any = new Bar();
        return obj instanceof Foo ? 1 : 0;
      }
    `,
        "test",
      ),
    ).toBe(0);
  });

  it("any-typed null value returns false", async () => {
    expect(
      await run(
        `
      class Foo { x: number; constructor() { this.x = 1; } }
      export function test(): number {
        let obj: any = null;
        return obj instanceof Foo ? 1 : 0;
      }
    `,
        "test",
      ),
    ).toBe(0);
  });

  it("nullable ref: non-null value matches", async () => {
    expect(
      await run(
        `
      class Foo { x: number; constructor() { this.x = 1; } }
      function maybeNull(b: number): Foo | null {
        if (b > 0) return new Foo();
        return null;
      }
      export function test(): number {
        let obj = maybeNull(1);
        if (obj instanceof Foo) return 1;
        return 0;
      }
    `,
        "test",
      ),
    ).toBe(1);
  });

  it("nullable ref: null value returns false", async () => {
    expect(
      await run(
        `
      class Foo { x: number; constructor() { this.x = 1; } }
      function maybeNull(b: number): Foo | null {
        if (b > 0) return new Foo();
        return null;
      }
      export function test(): number {
        let obj = maybeNull(0);
        if (obj instanceof Foo) return 1;
        return 0;
      }
    `,
        "test",
      ),
    ).toBe(0);
  });

  it("any-typed with class hierarchy", async () => {
    expect(
      await run(
        `
      class Base { x: number; constructor() { this.x = 1; } }
      class Child extends Base { y: number; constructor() { super(); this.y = 2; } }
      export function test(): number {
        let obj: any = new Child();
        let r = 0;
        if (obj instanceof Base) r = r + 1;
        if (obj instanceof Child) r = r + 2;
        return r;
      }
    `,
        "test",
      ),
    ).toBe(3);
  });

  it("instanceof result stored in variable", async () => {
    expect(
      await run(
        `
      class A { x: number; constructor() { this.x = 1; } }
      export function test(): number {
        let a = new A();
        let result = a instanceof A;
        return result ? 1 : 0;
      }
    `,
        "test",
      ),
    ).toBe(1);
  });

  it("instanceof with multiple unrelated classes via any", async () => {
    expect(
      await run(
        `
      class A { x: number; constructor() { this.x = 1; } }
      class B { y: number; constructor() { this.y = 2; } }
      class C { z: number; constructor() { this.z = 3; } }
      export function test(): number {
        let obj: any = new B();
        let r = 0;
        if (obj instanceof A) r = r + 1;
        if (obj instanceof B) r = r + 2;
        if (obj instanceof C) r = r + 4;
        return r;
      }
    `,
        "test",
      ),
    ).toBe(2);
  });
});
