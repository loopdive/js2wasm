import { describe, it, expect } from "vitest";
import { assertEquivalent } from "./equivalence/helpers.js";

describe("Finally block execution count (#588)", () => {
  it("finally runs exactly once on normal path", async () => {
    await assertEquivalent(
      `
      let count = 0;
      try {
        // normal, no exception
      } finally {
        count++;
      }
      export function test(): number {
        return count;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("finally runs exactly once when catch handles exception", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let count = 0;
        try {
          throw new Error("test");
        } catch (e) {
          // caught
        } finally {
          count++;
        }
        return count;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("finally runs exactly once on normal path with catch present", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let count = 0;
        try {
          // no exception
        } catch (e) {
          // not reached
        } finally {
          count++;
        }
        return count;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("finally mutation runs once - normal path", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let x = 20;
        try {
          x = 20;
        } catch (e) {
          x = 30;
        } finally {
          x = x + 1;
        }
        return x;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("finally mutation runs once - exception path", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let x = 10;
        try {
          throw new Error("boom");
        } catch (e) {
          x = 30;
        } finally {
          x = x + 1;
        }
        return x;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("try-finally without catch", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let count = 0;
        try {
          // normal
        } finally {
          count++;
        }
        return count;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("finally with multiple statements runs each once", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let a = 0;
        let b = 0;
        try {
          a = 10;
        } catch (e) {
          a = 20;
        } finally {
          a = a + 1;
          b = a * 2;
        }
        return a + b;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
