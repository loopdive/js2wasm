import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

describe("ClassExpression in various positions (#330)", () => {
  it("class expression in variable initializer with new", async () => {
    const result = compile(`
      const C = class {
        x: number;
        constructor(x: number) {
          this.x = x;
        }
        get(): number {
          return this.x;
        }
      };
      export function test(): number {
        const obj = new C(42);
        return obj.get();
      }
    `);
    expect(
      result.success,
      `Compile failed:\n${result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")}`,
    ).toBe(true);

    const { instance } = await WebAssembly.instantiate(result.binary, {
      env: {
        console_log_number: () => {},
        console_log_bool: () => {},
      },
    });
    const exports = instance.exports as any;
    expect(exports.test()).toBe(42);
  });

  it("named class expression", async () => {
    const result = compile(`
      const MyClass = class MyClassExpr {
        n: number;
        constructor(n: number) {
          this.n = n;
        }
        getN(): number {
          return this.n;
        }
      };
      export function test(): number {
        const obj = new MyClass(10);
        return obj.getN();
      }
    `);
    expect(
      result.success,
      `Compile failed:\n${result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")}`,
    ).toBe(true);

    const { instance } = await WebAssembly.instantiate(result.binary, {
      env: {
        console_log_number: () => {},
        console_log_bool: () => {},
      },
    });
    const exports = instance.exports as any;
    expect(exports.test()).toBe(10);
  });

  it("class expression with extends", async () => {
    const result = compile(`
      class Base {
        x: number;
        constructor(x: number) {
          this.x = x;
        }
        getX(): number {
          return this.x;
        }
      }
      const Child = class extends Base {
        y: number;
        constructor(x: number, y: number) {
          super(x);
          this.y = y;
        }
        sum(): number {
          return this.x + this.y;
        }
      };
      export function test(): number {
        const c = new Child(3, 4);
        return c.sum();
      }
    `);
    expect(
      result.success,
      `Compile failed:\n${result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")}`,
    ).toBe(true);

    const { instance } = await WebAssembly.instantiate(result.binary, {
      env: {
        console_log_number: () => {},
        console_log_bool: () => {},
      },
    });
    const exports = instance.exports as any;
    expect(exports.test()).toBe(7);
  });

  it("class expression inside a function body", async () => {
    const result = compile(`
      export function test(): number {
        const Inner = class {
          v: number;
          constructor(v: number) {
            this.v = v;
          }
          getV(): number {
            return this.v;
          }
        };
        const obj = new Inner(55);
        return obj.getV();
      }
    `);
    expect(
      result.success,
      `Compile failed:\n${result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")}`,
    ).toBe(true);

    const { instance } = await WebAssembly.instantiate(result.binary, {
      env: {
        console_log_number: () => {},
        console_log_bool: () => {},
      },
    });
    const exports = instance.exports as any;
    expect(exports.test()).toBe(55);
  });

  it("class expression in new expression (inline)", async () => {
    const result = compile(`
      export function test(): number {
        const obj = new (class {
          value: number;
          constructor(v: number) {
            this.value = v;
          }
          getValue(): number {
            return this.value;
          }
        })(100);
        return obj.getValue();
      }
    `);
    expect(
      result.success,
      `Compile failed:\n${result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")}`,
    ).toBe(true);

    const { instance } = await WebAssembly.instantiate(result.binary, {
      env: {
        console_log_number: () => {},
        console_log_bool: () => {},
      },
    });
    const exports = instance.exports as any;
    expect(exports.test()).toBe(100);
  });

  it("class expression with static-like pattern (multiple instances)", async () => {
    const result = compile(`
      const Pair = class {
        a: number;
        b: number;
        constructor(a: number, b: number) {
          this.a = a;
          this.b = b;
        }
        sum(): number {
          return this.a + this.b;
        }
      };
      export function test(): number {
        const p1 = new Pair(1, 2);
        const p2 = new Pair(10, 20);
        return p1.sum() + p2.sum();
      }
    `);
    expect(
      result.success,
      `Compile failed:\n${result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")}`,
    ).toBe(true);

    const { instance } = await WebAssembly.instantiate(result.binary, {
      env: {
        console_log_number: () => {},
        console_log_bool: () => {},
      },
    });
    const exports = instance.exports as any;
    expect(exports.test()).toBe(33);
  });

  it("class expression with no constructor", async () => {
    const result = compile(`
      const Simple = class {
        x: number = 5;
        getX(): number {
          return this.x;
        }
      };
      export function test(): number {
        const obj = new Simple();
        return obj.getX();
      }
    `);
    expect(
      result.success,
      `Compile failed:\n${result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")}`,
    ).toBe(true);

    const { instance } = await WebAssembly.instantiate(result.binary, {
      env: {
        console_log_number: () => {},
        console_log_bool: () => {},
      },
    });
    const exports = instance.exports as any;
    expect(exports.test()).toBe(5);
  });

  it("class expression assigned via binary expression with known type", async () => {
    // Use a class expression assigned via = but with proper type inference
    const result = compile(`
      class Base {
        val: number;
        constructor(v: number) {
          this.val = v;
        }
        getVal(): number {
          return this.val;
        }
      }
      const Derived = class extends Base {
        constructor(v: number) {
          super(v * 2);
        }
      };
      export function test(): number {
        const obj = new Derived(21);
        return obj.getVal();
      }
    `);
    expect(
      result.success,
      `Compile failed:\n${result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")}`,
    ).toBe(true);

    const { instance } = await WebAssembly.instantiate(result.binary, {
      env: {
        console_log_number: () => {},
        console_log_bool: () => {},
      },
    });
    const exports = instance.exports as any;
    expect(exports.test()).toBe(42);
  });
});
