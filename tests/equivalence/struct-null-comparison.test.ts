import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("struct ref null comparison", () => {
  it("obj !== null returns 1 when obj is non-null", async () => {
    await assertEquivalent(
      `
      class Foo { x: number = 1 }
      export function test(): number {
        let f: Foo | null = new Foo();
        return f !== null ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("obj === null returns 1 when obj is null", async () => {
    await assertEquivalent(
      `
      class Foo { x: number = 1 }
      export function test(): number {
        let f: Foo | null = null;
        return f === null ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("obj === null returns 0 when obj is non-null", async () => {
    await assertEquivalent(
      `
      class Foo { x: number = 1 }
      export function test(): number {
        let f: Foo | null = new Foo();
        return f === null ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("obj !== null returns 0 when obj is null", async () => {
    await assertEquivalent(
      `
      class Foo { x: number = 1 }
      export function test(): number {
        let f: Foo | null = null;
        return f !== null ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("null === obj (reversed operand order)", async () => {
    await assertEquivalent(
      `
      class Foo { x: number = 1 }
      export function test(): number {
        let f: Foo | null = new Foo();
        return null === f ? 0 : 1;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("null check in if statement", async () => {
    await assertEquivalent(
      `
      class Node { value: number = 42; next: Node | null = null; }
      export function test(): number {
        let n: Node | null = new Node();
        if (n !== null) {
          return n.value;
        }
        return 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("null check on null value in if statement", async () => {
    await assertEquivalent(
      `
      class Node { value: number = 42; next: Node | null = null; }
      export function test(): number {
        let n: Node | null = null;
        if (n === null) {
          return 1;
        }
        return 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
