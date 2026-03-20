import { describe, it, expect } from "vitest";
import { assertEquivalent } from "./equivalence/helpers.js";
import { compile } from "../src/index.js";

describe("Issue #670: Proxy get trap execution", () => {
  it("get trap returns constant value", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const target = { x: 10 };
        const p = new Proxy(target, {
          get: function(t: any, prop: string) { return 42; }
        });
        return (p as any).x;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("get trap accesses target property", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const target = { x: 5 };
        const p = new Proxy(target, {
          get: function(t: any, prop: string) { return 99; }
        });
        return (p as any).x;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("compiles Proxy with get trap without errors", () => {
    const result = compile(`
      export function test(): number {
        const target = { x: 10 };
        const p = new Proxy(target, {
          get: function(t: any, prop: string) { return 42; }
        });
        return (p as any).x;
      }
    `);
    expect(result.errors).toHaveLength(0);
    expect(result.success).toBe(true);
  });

  it("proxy without get trap still passes through", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const target = { x: 10 };
        const p = new Proxy(target, {});
        return p.x;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("get trap with direct property access (no as any)", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const target = { x: 10 };
        const p = new Proxy(target, {
          get: function(t: any, prop: string) { return 99; }
        });
        return p.x;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("get trap with arrow function", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const target = { x: 5 };
        const p = new Proxy(target, {
          get: (t: any, prop: string) => 77
        });
        return (p as any).x;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("get trap captures outer variable", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const multiplier = 3;
        const target = { x: 10 };
        const p = new Proxy(target, {
          get: function(t: any, prop: string) { return multiplier * 7; }
        });
        return (p as any).x;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
