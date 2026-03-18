import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("Array push/pop/length", () => {
  it("push single element and return new length", async () => {
    await assertEquivalent(
      `export function test(): number {
        const arr: number[] = [1, 2, 3];
        const len = arr.push(4);
        return len;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("push multiple elements", async () => {
    await assertEquivalent(
      `export function test(): number {
        const arr: number[] = [1];
        arr.push(2, 3, 4);
        return arr[2];
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("push and then read length", async () => {
    await assertEquivalent(
      `export function test(): number {
        const arr: number[] = [10, 20];
        arr.push(30);
        arr.push(40);
        return arr.length;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("pop returns last element", async () => {
    await assertEquivalent(
      `export function test(): number {
        const arr: number[] = [10, 20, 30];
        const val = arr.pop()!;
        return val;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("pop decrements length", async () => {
    await assertEquivalent(
      `export function test(): number {
        const arr: number[] = [1, 2, 3, 4];
        arr.pop();
        return arr.length;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("push then pop round-trip", async () => {
    await assertEquivalent(
      `export function test(): number {
        const arr: number[] = [1, 2];
        arr.push(99);
        const val = arr.pop()!;
        return val;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("multiple push and pop operations", async () => {
    await assertEquivalent(
      `export function test(): number {
        const arr: number[] = [];
        arr.push(10);
        arr.push(20);
        arr.push(30);
        arr.pop();
        arr.push(40);
        return arr[0] + arr[1] + arr[2];
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("length after series of push/pop", async () => {
    await assertEquivalent(
      `export function test(): number {
        const arr: number[] = [];
        arr.push(1);
        arr.push(2);
        arr.push(3);
        arr.pop();
        arr.pop();
        return arr.length;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("assign to length to truncate", async () => {
    await assertEquivalent(
      `export function test(): number {
        const arr: number[] = [1, 2, 3, 4, 5];
        arr.length = 3;
        return arr.length;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("assign to length = 0 clears array", async () => {
    await assertEquivalent(
      `export function test(): number {
        const arr: number[] = [1, 2, 3];
        arr.length = 0;
        return arr.length;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("push after truncation", async () => {
    await assertEquivalent(
      `export function test(): number {
        const arr: number[] = [1, 2, 3, 4, 5];
        arr.length = 2;
        arr.push(99);
        return arr[2];
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("string array push and pop", async () => {
    await assertEquivalent(
      `export function test(): string {
        const arr: string[] = ["a", "b"];
        arr.push("c");
        arr.pop();
        arr.push("d");
        return arr[2];
      }`,
      [{ fn: "test", args: [] }],
    );
  });
});
