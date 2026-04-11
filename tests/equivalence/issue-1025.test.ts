import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("#1025 — BindingElement nested array-pattern null vs undefined", () => {
  it("nested array pattern in object param: null preserved through default", async () => {
    await assertEquivalent(
      `
      export function test(): any {
        function f({ a: [x = 1] }: any): any { return x; }
        return f({ a: [null] });
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("nested array pattern in object param: undefined triggers default", async () => {
    await assertEquivalent(
      `
      export function test(): any {
        function f({ a: [x = 99] }: any): any { return x; }
        return f({ a: [undefined] });
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("nested array pattern in object decl: null preserved", async () => {
    await assertEquivalent(
      `
      export function test(): any {
        const { a: [x = 1] } = { a: [null] };
        return x;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("nested array pattern in object decl: undefined triggers default", async () => {
    await assertEquivalent(
      `
      export function test(): any {
        const { a: [x = 42] } = { a: [undefined] };
        return x;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("deeply nested array-in-object-in-object with null", async () => {
    await assertEquivalent(
      `
      export function test(): any {
        const { outer: { inner: [v = 7] } } = { outer: { inner: [null] } };
        return v;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("array pattern with default inside array pattern: null preserved", async () => {
    await assertEquivalent(
      `
      export function test(): any {
        const [[x = 1]] = [[null]];
        return x;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
