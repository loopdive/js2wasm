import { describe, it, expect } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("delete operator via sentinel (#1112)", () => {
  it("delete obj.prop returns true and property becomes undefined", async () => {
    await assertEquivalent(
      `export function test(): string {
        const obj: { a?: number; b?: number } = { a: 1, b: 2 };
        const deleted = delete obj.a;
        const afterA = obj.a;
        return deleted + "," + (afterA === undefined ? "undef" : String(afterA));
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("delete preserves other properties", async () => {
    await assertEquivalent(
      `export function test(): number {
        const obj: { x?: number; y?: number } = { x: 10, y: 20 };
        delete obj.x;
        return obj.y!;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("delete returns true for existing property", async () => {
    await assertEquivalent(
      `export function test(): string {
        const obj: { a?: number } = { a: 1 };
        return (delete obj.a) ? "true" : "false";
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("delete on literal returns true", async () => {
    await assertEquivalent(
      `export function test(): string {
        return (delete (0 as any)) ? "true" : "false";
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("delete string property makes it undefined", async () => {
    await assertEquivalent(
      `export function test(): string {
        const obj: { name?: string } = { name: "hello" };
        delete obj.name;
        return obj.name === undefined ? "deleted" : obj.name;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("delete result used in condition", async () => {
    await assertEquivalent(
      `export function test(): string {
        const obj: { a?: number } = { a: 1 };
        if (delete obj.a) {
          return "deleted";
        }
        return "not deleted";
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("multiple deletes on same object", async () => {
    await assertEquivalent(
      `export function test(): string {
        const obj: { a?: number; b?: number; c?: number } = { a: 1, b: 2, c: 3 };
        delete obj.a;
        delete obj.b;
        const results: string[] = [];
        results.push(obj.a === undefined ? "undef" : "defined");
        results.push(obj.b === undefined ? "undef" : "defined");
        results.push(obj.c === undefined ? "undef" : String(obj.c));
        return results.join(",");
      }`,
      [{ fn: "test", args: [] }],
    );
  });
});
