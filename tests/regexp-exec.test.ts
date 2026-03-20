import { describe, it, expect } from "vitest";
import { assertEquivalent, compileToWasm } from "./equivalence/helpers.js";

describe("RegExp exec() result unpacking (#676)", () => {
  it("RegExp.test() returns boolean", async () => {
    await assertEquivalent(
      `export function test(): number {
        const re = /hello/;
        return re.test("hello world") ? 1 : 0;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("RegExp.test() returns false on no match", async () => {
    await assertEquivalent(
      `export function test(): number {
        const re = /xyz/;
        return re.test("hello world") ? 1 : 0;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("RegExp.exec() returns match index", async () => {
    await assertEquivalent(
      `export function test(): number {
        const re = /(\d+)/;
        const result = re.exec("abc 123 def");
        if (result === null) return -1;
        return result.index;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("RegExp.exec() returns null on no match", async () => {
    await assertEquivalent(
      `export function test(): number {
        const re = /xyz/;
        const result = re.exec("hello world");
        return result === null ? 1 : 0;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("RegExp.exec() match group via result[0]", async () => {
    await assertEquivalent(
      `export function test(): string {
        const re = /(\d+)/;
        const result = re.exec("abc 123 def");
        if (result === null) return "none";
        return result[0];
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("RegExp.exec() capture group via result[1]", async () => {
    await assertEquivalent(
      `export function test(): string {
        const re = /(\d+)/;
        const result = re.exec("abc 123 def");
        if (result === null) return "none";
        return result[1];
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("RegExp.exec() input property", async () => {
    await assertEquivalent(
      `export function test(): string {
        const re = /hello/;
        const result = re.exec("hello world");
        if (result === null) return "none";
        return result.input;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("RegExp with global flag and lastIndex", async () => {
    await assertEquivalent(
      `export function test(): number {
        const re = /\d+/g;
        const first = re.exec("12 34 56");
        if (first === null) return -1;
        return first.index;
      }`,
      [{ fn: "test", args: [] }],
    );
  });
});
