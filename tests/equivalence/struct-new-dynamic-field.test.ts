import { describe, it, expect } from "vitest";
import { compileToWasm } from "./helpers.js";

describe("struct.new argument count with dynamically added fields (#571)", () => {
  it("class struct with all declared fields matches struct.new arg count", async () => {
    const exports = await compileToWasm(`
      class Box {
        width: number;
        height: number;
        constructor(w: number, h: number) {
          this.width = w;
          this.height = h;
        }
        area(): number {
          return this.width * this.height;
        }
      }
      export function test(): number {
        const b = new Box(3, 4);
        return b.area();
      }
    `);
    expect(exports.test()).toBe(12);
  });

  it("child class struct includes parent fields in struct.new", async () => {
    const exports = await compileToWasm(`
      class Base {
        x: number;
        constructor(x: number) {
          this.x = x;
        }
      }
      class Child extends Base {
        y: number;
        constructor(x: number, y: number) {
          super(x);
          this.y = y;
        }
      }
      export function test(): number {
        const c = new Child(10, 20);
        return c.x + c.y;
      }
    `);
    expect(exports.test()).toBe(30);
  });
});
