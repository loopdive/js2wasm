import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("Object.create", () => {
  it("Object.create(Foo.prototype) creates instance and fields can be set", async () => {
    await assertEquivalent(
      `
      class Foo {
        x: number;
        y: number;
        constructor() {
          this.x = 0;
          this.y = 0;
        }
      }
      export function test(): number {
        const obj = Object.create(Foo.prototype) as Foo;
        obj.x = 10;
        obj.y = 20;
        return obj.x + obj.y;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("Object.create(Foo.prototype) returns struct with zero-initialized fields", async () => {
    await assertEquivalent(
      `
      class Counter {
        count: number;
        constructor() {
          this.count = 0;
        }
        increment(): void {
          this.count = this.count + 1;
        }
      }
      export function test(): number {
        const c = Object.create(Counter.prototype) as Counter;
        c.count = 0;
        c.increment();
        c.increment();
        c.increment();
        return c.count;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
