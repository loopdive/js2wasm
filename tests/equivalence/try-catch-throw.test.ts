import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("Try/catch/throw (#340)", () => {
  it("throw new Error is caught by catch", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        try {
          throw new Error("oops");
          return 1;
        } catch (e) {
          return 42;
        }
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("throw string literal is caught", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        try {
          throw "error";
        } catch (e) {
          return 10;
        }
        return 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("throw number is caught", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        try {
          throw 99;
        } catch (e) {
          return 77;
        }
        return 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("code after throw in try is not executed", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var x: number = 0;
        try {
          x = 1;
          throw new Error("stop");
          x = 2;
        } catch (e) {
          // x should be 1, not 2
        }
        return x;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("try without throw runs normally", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var x: number = 0;
        try {
          x = 42;
        } catch (e) {
          x = -1;
        }
        return x;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("nested try-catch", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var result: number = 0;
        try {
          try {
            throw new Error("inner");
          } catch (e) {
            result = 10;
          }
          result = result + 1;
        } catch (e) {
          result = -1;
        }
        return result;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("throw in catch re-throws to outer try", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var result: number = 0;
        try {
          try {
            throw new Error("first");
          } catch (e) {
            result = 1;
            throw new Error("second");
          }
        } catch (e) {
          result = result + 10;
        }
        return result;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("try-finally without catch", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var x: number = 0;
        try {
          x = 1;
        } finally {
          x = x + 10;
        }
        return x;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("try-catch-finally normal path", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var x: number = 0;
        try {
          x = 1;
        } catch (e) {
          x = -1;
        } finally {
          x = x + 100;
        }
        return x;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("try-catch-finally exception path", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var x: number = 0;
        try {
          x = 1;
          throw new Error("fail");
        } catch (e) {
          x = x + 10;
        } finally {
          x = x + 100;
        }
        return x;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("throw from function called in try", async () => {
    await assertEquivalent(
      `
      function throwIt(): number {
        throw new Error("thrown");
        return 0;
      }
      export function test(): number {
        try {
          return throwIt();
        } catch (e) {
          return 55;
        }
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("catch without variable binding", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        try {
          throw new Error("x");
        } catch {
          return 33;
        }
        return 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("new TypeError handled inline", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        try {
          throw new TypeError("bad type");
        } catch (e) {
          return 88;
        }
        return 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("new RangeError handled inline", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        try {
          throw new RangeError("out of range");
        } catch (e) {
          return 77;
        }
        return 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
