import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("array inline methods should not hijack function return", () => {
  it("indexOf result should not return from enclosing function", async () => {
    await assertEquivalent(
      `export function test(): number {
        let a: number[] = [1, 2, 3];
        a.indexOf(1);
        return 42;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("indexOf result can be used in subsequent expressions", async () => {
    await assertEquivalent(
      `export function test(): number {
        let a: number[] = [1, 2, 3];
        let idx: number = a.indexOf(2);
        return idx + 100;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("lastIndexOf result should not return from enclosing function", async () => {
    await assertEquivalent(
      `export function test(): number {
        let a: number[] = [1, 2, 1];
        a.lastIndexOf(1);
        return 42;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("lastIndexOf result can be used in expressions", async () => {
    await assertEquivalent(
      `export function test(): number {
        let a: number[] = [1, 2, 1];
        let idx: number = a.lastIndexOf(1);
        return idx + 100;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("indexOf in if condition does not hijack return", async () => {
    await assertEquivalent(
      `export function test(): number {
        let a: number[] = [1, 2, 3];
        let idx: number = a.indexOf(1);
        if (idx === 0) { return 42; }
        return 99;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("includes does not hijack return", async () => {
    await assertEquivalent(
      `export function test(): number {
        let a: number[] = [1, 2, 3];
        if (a.includes(2)) { return 42; }
        return 99;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("findIndex does not hijack return", async () => {
    await assertEquivalent(
      `export function test(): number {
        let a: number[] = [1, 2, 3];
        let idx: number = a.findIndex((v: number) => v === 2);
        return idx + 100;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("find does not hijack return", async () => {
    await assertEquivalent(
      `export function test(): number {
        let a: number[] = [10, 20, 30];
        let val: number = a.find((v: number) => v > 15);
        return val;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("multiple indexOf calls in same function", async () => {
    await assertEquivalent(
      `export function test(): number {
        let a: number[] = [1, 2, 3, 4, 5];
        let i1: number = a.indexOf(2);
        let i2: number = a.indexOf(4);
        return i1 + i2;
      }`,
      [{ fn: "test", args: [] }],
    );
  });
});
