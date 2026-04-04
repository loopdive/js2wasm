import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function run(source: string, fn: string, args: unknown[] = []): Promise<unknown> {
  const result = compile(source);
  if (!result.success) {
    throw new Error("Compile failed:\n" + result.errors.map((e) => "  L" + e.line + ": " + e.message).join("\n"));
  }
  const { instance } = await WebAssembly.instantiate(result.binary, { env: {} });
  return (instance.exports as any)[fn](...args);
}

function compiles(source: string): boolean {
  const result = compile(source);
  return result.success;
}

function compileErrors(source: string): string[] {
  const result = compile(source);
  return result.errors?.map((e) => e.message) ?? [];
}

describe("issue-234: ClassDeclaration in nested/expression positions", () => {
  it("class inside regular function body", async () => {
    expect(
      await run(
        `
function wrapper(): number {
  class C {
    value: number;
    constructor(v: number) { this.value = v; }
  }
  const obj = new C(42);
  return obj.value;
}
export function test(): number { return wrapper(); }
`,
        "test",
      ),
    ).toBe(42);
  });

  it("class inside export function body", async () => {
    expect(
      await run(
        `
export function test(): number {
  class C {
    value: number;
    constructor(v: number) { this.value = v; }
  }
  const obj = new C(42);
  return obj.value;
}
`,
        "test",
      ),
    ).toBe(42);
  });

  it("class with method inside function body", async () => {
    expect(
      await run(
        `
export function test(): number {
  class C {
    value: number;
    constructor(v: number) { this.value = v; }
    getDouble(): number { return this.value * 2; }
  }
  const obj = new C(21);
  return obj.getDouble();
}
`,
        "test",
      ),
    ).toBe(42);
  });

  it("class inside if block", async () => {
    expect(
      await run(
        `
export function test(): number {
  if (true) {
    class C {
      value: number;
      constructor(v: number) { this.value = v; }
    }
    const obj = new C(42);
    return obj.value;
  }
  return 0;
}
`,
        "test",
      ),
    ).toBe(42);
  });

  it("class inside nested block", async () => {
    expect(
      await run(
        `
export function test(): number {
  {
    class C {
      value: number;
      constructor(v: number) { this.value = v; }
    }
    const obj = new C(42);
    return obj.value;
  }
}
`,
        "test",
      ),
    ).toBe(42);
  });

  it("two classes inside same function", async () => {
    expect(
      await run(
        `
export function test(): number {
  class A {
    x: number;
    constructor(x: number) { this.x = x; }
  }
  class B {
    y: number;
    constructor(y: number) { this.y = y; }
  }
  return new A(10).x + new B(32).y;
}
`,
        "test",
      ),
    ).toBe(42);
  });

  it("class expression as standalone expression compiles without error", () => {
    const errors = compileErrors(`
export function test(): number {
  const C = class MyClass {
    x: number;
    constructor() { this.x = 42; }
  };
  return new C().x;
}
`);
    // Should not have "Unsupported expression: ClassExpression"
    const classExprErrors = errors.filter((e) => e.includes("ClassExpression"));
    expect(classExprErrors).toEqual([]);
  });

  it("class inside for loop body compiles", () => {
    expect(
      compiles(`
export function test(): number {
  let sum = 0;
  for (let i = 0; i < 1; i++) {
    class C {
      value: number;
      constructor(v: number) { this.value = v; }
    }
    sum = sum + new C(42).value;
  }
  return sum;
}
`),
    ).toBe(true);
  });

  it("class extends inside function body", async () => {
    expect(
      await run(
        `
export function test(): number {
  class Base {
    x: number;
    constructor(x: number) { this.x = x; }
  }
  class Derived extends Base {
    y: number;
    constructor(x: number, y: number) {
      super(x);
      this.y = y;
    }
  }
  const d = new Derived(10, 32);
  return d.x + d.y;
}
`,
        "test",
      ),
    ).toBe(42);
  });

  it("anonymous class in new expression", async () => {
    expect(
      await run(
        `
export function test(): number {
  const obj = new (class {
    x: number;
    constructor() { this.x = 42; }
  })();
  return obj.x;
}
`,
        "test",
      ),
    ).toBe(42);
  });
});
