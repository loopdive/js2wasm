import { describe, it, expect } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("Symbol basic support (#471)", () => {
  it("Symbol() creates unique values", async () => {
    await assertEquivalent(
      `export function test(): string {
        const a = Symbol();
        const b = Symbol();
        return a !== b ? "unique" : "same";
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("Symbol with description (description discarded)", async () => {
    await assertEquivalent(
      `export function test(): string {
        const a = Symbol("foo");
        const b = Symbol("foo");
        return a !== b ? "unique" : "same";
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("Symbol equality with itself", async () => {
    await assertEquivalent(
      `export function test(): string {
        const s = Symbol();
        return s === s ? "same" : "different";
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("typeof Symbol() is symbol", async () => {
    await assertEquivalent(
      `export function test(): string {
        const s = Symbol();
        return typeof s === "symbol" ? "yes" : "no";
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("Symbol.iterator is a constant", async () => {
    await assertEquivalent(
      `export function test(): string {
        const iter = Symbol.iterator;
        return typeof iter === "symbol" ? "symbol" : "other";
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("well-known symbols are consistent", async () => {
    await assertEquivalent(
      `export function test(): string {
        const a = Symbol.iterator;
        const b = Symbol.iterator;
        return a === b ? "same" : "different";
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("Symbol.iterator differs from Symbol.hasInstance", async () => {
    await assertEquivalent(
      `export function test(): string {
        return Symbol.iterator !== Symbol.hasInstance ? "different" : "same";
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("Symbol() differs from well-known symbols", async () => {
    await assertEquivalent(
      `export function test(): string {
        const s = Symbol();
        return s !== Symbol.iterator ? "different" : "same";
      }`,
      [{ fn: "test", args: [] }],
    );
  });
});
