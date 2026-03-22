import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("Object.defineProperty TypeError (#724)", { timeout: 15000 }, () => {
  it("throws when redefining non-configurable with configurable: true", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var o: any = {};
        Object.defineProperty(o, "foo", { value: 1, configurable: false });
        try {
          Object.defineProperty(o, "foo", { configurable: true });
          return 0;
        } catch(e) {
          return 1;
        }
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("throws when changing enumerable on non-configurable", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var o: any = {};
        Object.defineProperty(o, "foo", { value: 1, enumerable: false, configurable: false });
        try {
          Object.defineProperty(o, "foo", { enumerable: true });
          return 0;
        } catch(e) {
          return 1;
        }
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("throws when setting value on non-configurable non-writable", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var o: any = {};
        Object.defineProperty(o, "foo", { value: 1, writable: false, configurable: false });
        try {
          Object.defineProperty(o, "foo", { value: 2 });
          return 0;
        } catch(e) {
          return 1;
        }
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("allows redefining configurable property", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var o: any = {};
        Object.defineProperty(o, "foo", { value: 1, configurable: true });
        Object.defineProperty(o, "foo", { value: 2, configurable: true });
        return o.foo;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("throws on preventExtensions then defineProperty", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var o: any = {};
        Object.preventExtensions(o);
        try {
          Object.defineProperty(o, "foo", { value: 1 });
          return 0;
        } catch(e) {
          return 1;
        }
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("no-op redefine of same descriptor succeeds", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var o: any = {};
        Object.defineProperty(o, "foo", { value: 1, writable: false, configurable: false });
        Object.defineProperty(o, "foo", { value: 1, writable: false });
        return o.foo;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
