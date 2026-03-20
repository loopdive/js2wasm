import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("Array bounds check elimination (#464)", () => {
  it("for-loop with i < arr.length: basic sum", async () => {
    await assertEquivalent(
      `export function test(): number {
        const arr: number[] = [10, 20, 30, 40, 50];
        let sum = 0;
        for (let i = 0; i < arr.length; i++) {
          sum += arr[i];
        }
        return sum;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("for-loop with i < arr.length: string array", async () => {
    await assertEquivalent(
      `export function test(): string {
        const words: string[] = ["hello", " ", "world"];
        let result = "";
        for (let i = 0; i < words.length; i++) {
          result += words[i];
        }
        return result;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("nested for-loops with bounds check elimination", async () => {
    await assertEquivalent(
      `export function test(): number {
        const a: number[] = [1, 2, 3];
        const b: number[] = [10, 20];
        let sum = 0;
        for (let i = 0; i < a.length; i++) {
          for (let j = 0; j < b.length; j++) {
            sum += a[i] * b[j];
          }
        }
        return sum;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("for-loop without bounds pattern still works", async () => {
    await assertEquivalent(
      `export function test(): number {
        const arr: number[] = [5, 10, 15];
        let sum = 0;
        for (let i = 0; i < 3; i++) {
          sum += arr[i];
        }
        return sum;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("reversed comparison: arr.length > i", async () => {
    await assertEquivalent(
      `export function test(): number {
        const arr: number[] = [100, 200, 300];
        let sum = 0;
        for (let i = 0; arr.length > i; i++) {
          sum += arr[i];
        }
        return sum;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("empty array for-loop does not trap", async () => {
    await assertEquivalent(
      `export function test(): number {
        const arr: number[] = [];
        let sum = 0;
        for (let i = 0; i < arr.length; i++) {
          sum += arr[i];
        }
        return sum;
      }`,
      [{ fn: "test", args: [] }],
    );
  });
});
