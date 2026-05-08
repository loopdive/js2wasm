import { describe, it } from "vitest";
import { assertEquivalent } from "./equivalence/helpers.js";

describe("issue #1360 — Array.prototype.{indexOf,lastIndexOf,includes} spec semantics", () => {
  describe("array-like receivers (Array.prototype.METHOD.call)", () => {
    it("Array.prototype.indexOf.call(arrayLike, true) returns the index", async () => {
      await assertEquivalent(
        `export function test(): number {
          var obj: any = { 0: false, 1: true, length: 2 };
          return Array.prototype.indexOf.call(obj, true);
        }`,
        [{ fn: "test", args: [] }],
      );
    });

    it("Array.prototype.indexOf.call returns -1 for missing element", async () => {
      await assertEquivalent(
        `export function test(): number {
          var obj: any = { 2: true, length: 2 };
          return Array.prototype.indexOf.call(obj, true);
        }`,
        [{ fn: "test", args: [] }],
      );
    });

    it("Array.prototype.indexOf.call respects fromIndex", async () => {
      await assertEquivalent(
        `export function test(): number {
          var obj: any = { 0: 1, 1: 2, 2: 1, length: 3 };
          return Array.prototype.indexOf.call(obj, 1, 1);
        }`,
        [{ fn: "test", args: [] }],
      );
    });

    it("Array.prototype.lastIndexOf.call returns the last index", async () => {
      await assertEquivalent(
        `export function test(): number {
          var obj: any = { 0: 1, 1: 2, 2: 1, length: 3 };
          return Array.prototype.lastIndexOf.call(obj, 1);
        }`,
        [{ fn: "test", args: [] }],
      );
    });

    it("Array.prototype.includes.call returns true for present element", async () => {
      await assertEquivalent(
        `export function test(): number {
          var obj: any = { 0: 1, 1: 2, 2: 3, length: 3 };
          return Array.prototype.includes.call(obj, 2) ? 1 : 0;
        }`,
        [{ fn: "test", args: [] }],
      );
    });

    it("Array.prototype.includes.call with NaN finds NaN (SameValueZero)", async () => {
      await assertEquivalent(
        `export function test(): number {
          var obj: any = { 0: 1, 1: NaN, 2: 3, length: 3 };
          return Array.prototype.includes.call(obj, NaN) ? 1 : 0;
        }`,
        [{ fn: "test", args: [] }],
      );
    });

    it("Array.prototype.indexOf.call returns -1 for empty array-like", async () => {
      await assertEquivalent(
        `export function test(): number {
          var obj: any = { length: 0 };
          return Array.prototype.indexOf.call(obj, 1);
        }`,
        [{ fn: "test", args: [] }],
      );
    });
  });

  describe("indexOf — strict equality", () => {
    it("[NaN].indexOf(NaN) returns -1 (NaN !== NaN)", async () => {
      await assertEquivalent(
        `export function test(): number {
          var arr: number[] = [NaN];
          return arr.indexOf(NaN);
        }`,
        [{ fn: "test", args: [] }],
      );
    });

    it("[1, NaN, 3].indexOf(NaN) returns -1", async () => {
      await assertEquivalent(
        `export function test(): number {
          var arr: number[] = [1, NaN, 3];
          return arr.indexOf(NaN);
        }`,
        [{ fn: "test", args: [] }],
      );
    });

    it("[-0].indexOf(0) returns 0 (+0 === -0 strictly)", async () => {
      await assertEquivalent(
        `export function test(): number {
          var arr: number[] = [-0];
          return arr.indexOf(0);
        }`,
        [{ fn: "test", args: [] }],
      );
    });

    it("[0].indexOf(-0) returns 0", async () => {
      await assertEquivalent(
        `export function test(): number {
          var arr: number[] = [0];
          return arr.indexOf(-0);
        }`,
        [{ fn: "test", args: [] }],
      );
    });

    it("[1, 2, 3].indexOf(2) returns 1", async () => {
      await assertEquivalent(
        `export function test(): number {
          var arr: number[] = [1, 2, 3];
          return arr.indexOf(2);
        }`,
        [{ fn: "test", args: [] }],
      );
    });

    it("[1, 2, 3].indexOf(4) returns -1", async () => {
      await assertEquivalent(
        `export function test(): number {
          var arr: number[] = [1, 2, 3];
          return arr.indexOf(4);
        }`,
        [{ fn: "test", args: [] }],
      );
    });
  });

  describe("indexOf — fromIndex coercion", () => {
    it("[1, 2, 3].indexOf(2, Infinity) returns -1", async () => {
      await assertEquivalent(
        `export function test(): number {
          var arr: number[] = [1, 2, 3];
          return arr.indexOf(2, Infinity);
        }`,
        [{ fn: "test", args: [] }],
      );
    });

    it("[1, 2, 3].indexOf(2, -Infinity) returns 1", async () => {
      await assertEquivalent(
        `export function test(): number {
          var arr: number[] = [1, 2, 3];
          return arr.indexOf(2, -Infinity);
        }`,
        [{ fn: "test", args: [] }],
      );
    });

    it("[1, 2, 3].indexOf(2, NaN) returns 1 (NaN treated as 0)", async () => {
      await assertEquivalent(
        `export function test(): number {
          var arr: number[] = [1, 2, 3];
          return arr.indexOf(2, NaN);
        }`,
        [{ fn: "test", args: [] }],
      );
    });

    it("[1, 2, 3].indexOf(1, 5) returns -1 (fromIndex >= length)", async () => {
      await assertEquivalent(
        `export function test(): number {
          var arr: number[] = [1, 2, 3];
          return arr.indexOf(1, 5);
        }`,
        [{ fn: "test", args: [] }],
      );
    });

    it("[1, 2, 3].indexOf(1, -5) returns 0 (negative clamped to 0)", async () => {
      await assertEquivalent(
        `export function test(): number {
          var arr: number[] = [1, 2, 3];
          return arr.indexOf(1, -5);
        }`,
        [{ fn: "test", args: [] }],
      );
    });

    it("[1, 2, 3].indexOf(1, -2) returns -1 (start at len-2)", async () => {
      await assertEquivalent(
        `export function test(): number {
          var arr: number[] = [1, 2, 3];
          return arr.indexOf(1, -2);
        }`,
        [{ fn: "test", args: [] }],
      );
    });
  });

  describe("lastIndexOf — strict equality", () => {
    it("[NaN].lastIndexOf(NaN) returns -1", async () => {
      await assertEquivalent(
        `export function test(): number {
          var arr: number[] = [NaN];
          return arr.lastIndexOf(NaN);
        }`,
        [{ fn: "test", args: [] }],
      );
    });

    it("[1, 2, 2, 3].lastIndexOf(2) returns 2", async () => {
      await assertEquivalent(
        `export function test(): number {
          var arr: number[] = [1, 2, 2, 3];
          return arr.lastIndexOf(2);
        }`,
        [{ fn: "test", args: [] }],
      );
    });

    it("[-0, 0].lastIndexOf(0) returns 1 (+0 === -0)", async () => {
      await assertEquivalent(
        `export function test(): number {
          var arr: number[] = [-0, 0];
          return arr.lastIndexOf(0);
        }`,
        [{ fn: "test", args: [] }],
      );
    });
  });

  describe("lastIndexOf — fromIndex coercion", () => {
    it("[1, 2, 3].lastIndexOf(2, Infinity) returns 1 (clamped to len-1)", async () => {
      await assertEquivalent(
        `export function test(): number {
          var arr: number[] = [1, 2, 3];
          return arr.lastIndexOf(2, Infinity);
        }`,
        [{ fn: "test", args: [] }],
      );
    });

    it("[1, 2, 3].lastIndexOf(2, -Infinity) returns -1 (search nothing)", async () => {
      await assertEquivalent(
        `export function test(): number {
          var arr: number[] = [1, 2, 3];
          return arr.lastIndexOf(2, -Infinity);
        }`,
        [{ fn: "test", args: [] }],
      );
    });

    it("[1, 2, 3].lastIndexOf(2, NaN) returns -1 (NaN treated as 0; only index 0 searched)", async () => {
      await assertEquivalent(
        `export function test(): number {
          var arr: number[] = [1, 2, 3];
          return arr.lastIndexOf(2, NaN);
        }`,
        [{ fn: "test", args: [] }],
      );
    });

    it("[1, 2, 3].lastIndexOf(1, NaN) returns 0 (NaN treated as 0)", async () => {
      await assertEquivalent(
        `export function test(): number {
          var arr: number[] = [1, 2, 3];
          return arr.lastIndexOf(1, NaN);
        }`,
        [{ fn: "test", args: [] }],
      );
    });

    it("[1, 2, 3].lastIndexOf(2, -1) returns 1 (start at len-1)", async () => {
      await assertEquivalent(
        `export function test(): number {
          var arr: number[] = [1, 2, 3];
          return arr.lastIndexOf(2, -1);
        }`,
        [{ fn: "test", args: [] }],
      );
    });

    it("[1, 2, 3].lastIndexOf(2, -10) returns -1 (negative beyond start)", async () => {
      await assertEquivalent(
        `export function test(): number {
          var arr: number[] = [1, 2, 3];
          return arr.lastIndexOf(2, -10);
        }`,
        [{ fn: "test", args: [] }],
      );
    });
  });

  describe("includes — SameValueZero", () => {
    it("[NaN].includes(NaN) returns true", async () => {
      await assertEquivalent(
        `export function test(): number {
          var arr: number[] = [NaN];
          return arr.includes(NaN) ? 1 : 0;
        }`,
        [{ fn: "test", args: [] }],
      );
    });

    it("[1, NaN, 3].includes(NaN) returns true", async () => {
      await assertEquivalent(
        `export function test(): number {
          var arr: number[] = [1, NaN, 3];
          return arr.includes(NaN) ? 1 : 0;
        }`,
        [{ fn: "test", args: [] }],
      );
    });

    it("[-0].includes(0) returns true (+0 SameValueZero -0)", async () => {
      await assertEquivalent(
        `export function test(): number {
          var arr: number[] = [-0];
          return arr.includes(0) ? 1 : 0;
        }`,
        [{ fn: "test", args: [] }],
      );
    });

    it("[1, 2, 3].includes(2, Infinity) returns false", async () => {
      await assertEquivalent(
        `export function test(): number {
          var arr: number[] = [1, 2, 3];
          return arr.includes(2, Infinity) ? 1 : 0;
        }`,
        [{ fn: "test", args: [] }],
      );
    });

    it("[1, 2, 3].includes(2, -Infinity) returns true", async () => {
      await assertEquivalent(
        `export function test(): number {
          var arr: number[] = [1, 2, 3];
          return arr.includes(2, -Infinity) ? 1 : 0;
        }`,
        [{ fn: "test", args: [] }],
      );
    });

    it("[1, 2, 3].includes(2, NaN) returns true (NaN treated as 0)", async () => {
      await assertEquivalent(
        `export function test(): number {
          var arr: number[] = [1, 2, 3];
          return arr.includes(2, NaN) ? 1 : 0;
        }`,
        [{ fn: "test", args: [] }],
      );
    });
  });
});
