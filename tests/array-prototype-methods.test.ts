import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("array prototype methods", () => {
  it("indexOf returns correct index", async () => {
    await assertEquivalent(
      `export function test(): number {
        var arr: number[] = [1, 2, 3];
        return arr.indexOf(2);
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("indexOf returns -1 for missing element", async () => {
    await assertEquivalent(
      `export function test(): number {
        var arr: number[] = [1, 2, 3];
        return arr.indexOf(5);
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("indexOf with fromIndex", async () => {
    await assertEquivalent(
      `export function test(): number {
        var arr: number[] = [1, 2, 3, 2, 1];
        return arr.indexOf(2, 2);
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("lastIndexOf returns correct index", async () => {
    await assertEquivalent(
      `export function test(): number {
        var arr: number[] = [1, 2, 3, 2, 1];
        return arr.lastIndexOf(2);
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("forEach passes correct element", async () => {
    await assertEquivalent(
      `export function test(): number {
        var sum = 0;
        var arr: number[] = [10, 20, 30];
        arr.forEach(function(x: number) { sum += x; });
        return sum;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("forEach passes correct index", async () => {
    await assertEquivalent(
      `export function test(): number {
        var indexSum = 0;
        var arr: number[] = [10, 20, 30];
        arr.forEach(function(x: number, i: number) { indexSum += i; });
        return indexSum;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("map with index", async () => {
    await assertEquivalent(
      `export function test(): number {
        var arr: number[] = [10, 20, 30];
        var result = arr.map(function(x: number, i: number): number { return x + i; });
        return result[0] + result[1] + result[2];
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("filter returns correct elements", async () => {
    await assertEquivalent(
      `export function test(): number {
        var arr: number[] = [1, 2, 3, 4, 5];
        var evens = arr.filter(function(x: number): boolean { return x % 2 === 0; });
        return evens.length;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("reduce sums correctly", async () => {
    await assertEquivalent(
      `export function test(): number {
        var arr: number[] = [1, 2, 3, 4, 5];
        return arr.reduce(function(acc: number, x: number): number { return acc + x; }, 0);
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("some returns true when match found", async () => {
    await assertEquivalent(
      `export function test(): number {
        var arr: number[] = [1, 2, 3];
        var result = arr.some(function(x: number): boolean { return x > 2; });
        return result ? 1 : 0;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("every returns false when not all match", async () => {
    await assertEquivalent(
      `export function test(): number {
        var arr: number[] = [1, 2, 3];
        var result = arr.every(function(x: number): boolean { return x > 1; });
        return result ? 1 : 0;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("findIndex returns correct index", async () => {
    await assertEquivalent(
      `export function test(): number {
        var arr: number[] = [10, 20, 30];
        return arr.findIndex(function(x: number): boolean { return x === 20; });
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("includes returns correct boolean", async () => {
    await assertEquivalent(
      `export function test(): number {
        var arr: number[] = [1, 2, 3];
        var a = arr.includes(2) ? 1 : 0;
        var b = arr.includes(5) ? 1 : 0;
        return a * 10 + b;
      }`,
      [{ fn: "test", args: [] }],
    );
  });
});
