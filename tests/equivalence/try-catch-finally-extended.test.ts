import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("try/catch/finally extended", () => {
  it("finally runs after normal return in try", async () => {
    await assertEquivalent(
      `
      let counter = 0;
      function inc(): void { counter++; }
      export function test(): number {
        counter = 0;
        try {
          inc();
        } finally {
          inc();
        }
        return counter;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("finally runs after throw and catch", async () => {
    await assertEquivalent(
      `
      let counter = 0;
      export function test(): number {
        counter = 0;
        try {
          counter = 1;
          throw new Error("boom");
        } catch (e) {
          counter = counter + 10;
        } finally {
          counter = counter + 100;
        }
        return counter;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("finally with no catch, no exception", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let x = 0;
        try {
          x = 5;
        } finally {
          x = x * 2;
        }
        return x;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("multiple catch blocks in sequence", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let r = 0;
        try {
          throw new Error("a");
        } catch (e) {
          r += 1;
        }
        try {
          throw new Error("b");
        } catch (e) {
          r += 10;
        }
        try {
          r += 100;
        } catch (e) {
          r += 1000;
        }
        return r;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("exception propagation through nested try-catch", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let result = 0;
        try {
          try {
            try {
              throw new Error("deep");
            } catch (e) {
              result = 1;
              throw new Error("rethrow");
            }
          } catch (e) {
            result = result + 10;
          }
        } catch (e) {
          result = -1;
        }
        return result;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("try-catch in a loop", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let caught = 0;
        for (let i = 0; i < 5; i++) {
          try {
            if (i % 2 === 0) throw new Error("even");
          } catch (e) {
            caught++;
          }
        }
        return caught;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("finally in a loop", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let finallyCount = 0;
        for (let i = 0; i < 3; i++) {
          try {
            if (i === 1) throw new Error("skip");
          } catch (e) {
            // caught
          } finally {
            finallyCount++;
          }
        }
        return finallyCount;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
