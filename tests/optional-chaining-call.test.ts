import { describe, it, expect } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("optional chaining calls (#409)", () => {
  it("obj?.method() on non-null local class instance", async () => {
    await assertEquivalent(
      `class Greeter {
        greet(): string { return "hello"; }
      }
      export function test(): string {
        const g: Greeter | null = new Greeter();
        return g?.greet() ?? "fallback";
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("obj?.method() on null local class instance", async () => {
    await assertEquivalent(
      `class Greeter {
        greet(): string { return "hello"; }
      }
      export function test(): string {
        const g: Greeter | null = null;
        return g?.greet() ?? "fallback";
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("obj?.method() with arguments on non-null", async () => {
    await assertEquivalent(
      `class Calculator {
        add(a: number, b: number): number { return a + b; }
      }
      export function test(): number {
        const c: Calculator | null = new Calculator();
        return c?.add(3, 4) ?? -1;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("obj?.method() with arguments on null", async () => {
    await assertEquivalent(
      `class Calculator {
        add(a: number, b: number): number { return a + b; }
      }
      export function test(): number {
        const c: Calculator | null = null;
        return c?.add(3, 4) ?? -1;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("optional chaining on inherited method", async () => {
    await assertEquivalent(
      `class Base {
        name(): string { return "base"; }
      }
      class Child extends Base {}
      export function test(): string {
        const c: Child | null = new Child();
        return c?.name() ?? "none";
      }`,
      [{ fn: "test", args: [] }],
    );
  });
});
