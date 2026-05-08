/**
 * Tests for issue #1366a: extends Error / TypeError / RangeError / etc.
 *
 * Before: subclasses of builtin error types had no way to access `.message`
 * (super(msg) was a no-op because the builtin parent has no Wasm struct
 * fields), and `subInstance instanceof Error` returned false because the
 * builtin parent has no struct tag in our system.
 *
 * Fix:
 *   1. Auto-add `message: externref` field to subclasses of builtin errors
 *      when the user didn't already declare/assign one.
 *   2. `compileSuperCall` populates `this.message` from the first super(...)
 *      argument (or argument #1 for AggregateError, which takes
 *      (errors, message)).
 *   3. `tryStaticInstanceOf` recognises the builtin-error chain:
 *      `subInstance instanceof <BuiltinError>` returns true when the LHS
 *      class extends that builtin (or any builtin error, when the RHS is
 *      Error itself — every NativeError ⊂ Error per spec).
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runTest(src: string): Promise<unknown> {
  const r = compile(src, { fileName: "test.ts" });
  if (!r.success) throw new Error(`compile failed: ${r.errors[0]?.message}`);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  return (instance.exports as Record<string, () => unknown>).test!();
}

describe("issue #1366a: class extends builtin Error", () => {
  it("AC#1: sub instanceof MyError", async () => {
    const src = `
class MyError extends Error { constructor(msg: string) { super(msg); } }
export function test(): number {
  return new MyError("x") instanceof MyError ? 1 : 0;
}
`;
    expect(await runTest(src)).toBe(1);
  });

  it("AC#2: sub instanceof Error", async () => {
    const src = `
class MyError extends Error { constructor(msg: string) { super(msg); } }
export function test(): number {
  return new MyError("x") instanceof Error ? 1 : 0;
}
`;
    expect(await runTest(src)).toBe(1);
  });

  it("AC#3: sub.message returns the super-call argument", async () => {
    const src = `
class MyError extends Error { constructor(msg: string) { super(msg); } }
export function test(): string {
  return new MyError("hello world").message;
}
`;
    expect(await runTest(src)).toBe("hello world");
  });

  it("TypeError subclass — sub instanceof TypeError", async () => {
    const src = `
class MyTE extends TypeError { constructor(msg: string) { super(msg); } }
export function test(): number {
  return new MyTE("x") instanceof TypeError ? 1 : 0;
}
`;
    expect(await runTest(src)).toBe(1);
  });

  it("TypeError subclass — sub instanceof Error (transitive: TypeError ⊂ Error)", async () => {
    const src = `
class MyTE extends TypeError { constructor(msg: string) { super(msg); } }
export function test(): number {
  return new MyTE("x") instanceof Error ? 1 : 0;
}
`;
    expect(await runTest(src)).toBe(1);
  });

  it("TypeError subclass is NOT instanceof RangeError (orthogonal builtin)", async () => {
    const src = `
class MyTE extends TypeError { constructor(msg: string) { super(msg); } }
export function test(): number {
  return new MyTE("x") instanceof RangeError ? 1 : 0;
}
`;
    expect(await runTest(src)).toBe(0);
  });

  it("subclass with extra fields preserves them alongside message", async () => {
    const src = `
class RangeErr extends RangeError {
  code: number;
  constructor(msg: string, code: number) { super(msg); this.code = code; }
}
export function test(): number {
  const e = new RangeErr("oob", 42);
  if (e.message !== "oob") return 100;
  if (e.code !== 42) return 101;
  if (!(e instanceof RangeErr)) return 102;
  if (!(e instanceof RangeError)) return 103;
  if (!(e instanceof Error)) return 104;
  if (e instanceof TypeError) return 105;
  return 1;
}
`;
    expect(await runTest(src)).toBe(1);
  });

  it("each builtin NativeError subclass: instanceof self + Error", async () => {
    const tests: { ctor: string }[] = [
      { ctor: "EvalError" },
      { ctor: "RangeError" },
      { ctor: "ReferenceError" },
      { ctor: "SyntaxError" },
      { ctor: "TypeError" },
      { ctor: "URIError" },
    ];
    for (const { ctor } of tests) {
      const src = `
class Sub extends ${ctor} { constructor(msg: string) { super(msg); } }
export function test(): number {
  const sub = new Sub("m");
  if (!(sub instanceof Sub)) return 2;
  if (!(sub instanceof ${ctor})) return 3;
  if (!(sub instanceof Error)) return 4;
  return 1;
}
`;
      expect(await runTest(src)).toBe(1);
    }
  });

  it("regression: regular user class is NOT instanceof Error", async () => {
    const src = `
class Foo {
  a: number;
  constructor(a: number) { this.a = a; }
}
export function test(): number {
  return new Foo(1) instanceof Error ? 0 : 1;
}
`;
    expect(await runTest(src)).toBe(1);
  });

  it("regression: two-level user-class chain still works", async () => {
    const src = `
class A { x: number; constructor(x: number) { this.x = x; } }
class B extends A { y: number; constructor(x: number, y: number) { super(x); this.y = y; } }
export function test(): number {
  const b = new B(2, 3);
  if (b.x !== 2 || b.y !== 3) return 0;
  if (!(b instanceof A) || !(b instanceof B)) return 0;
  if (b instanceof Error) return 0;
  return 1;
}
`;
    expect(await runTest(src)).toBe(1);
  });
});
