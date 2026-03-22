import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("issue-726: ref.cast guard regression", () => {
  it("function returning generic object used with different interface", async () => {
    await assertEquivalent(
      `
      function makeObj(): any {
        return { x: 42, y: 99 };
      }
      export function test(): number {
        const obj: any = makeObj();
        return obj.x;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("property access through any-typed variable", async () => {
    await assertEquivalent(
      `
      interface A { val: number; }
      function create(): A { return { val: 7 }; }
      export function test(): number {
        const x: any = create();
        return x.val;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("class property access when type is widened", async () => {
    await assertEquivalent(
      `
      class Foo { bar: number = 5; }
      function makeFoo(): object { return new Foo(); }
      export function test(): number {
        const f: any = makeFoo();
        return f.bar;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
