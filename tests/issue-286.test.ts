import { describe, it, expect } from "vitest";
import { assertEquivalent, compileToWasm } from "./equivalence/helpers.js";

describe("Issue #286: Logical assignment on property/element access", () => {
  describe("logical assignment on property access", () => {
    it("&&= assigns when property is truthy", async () => {
      await assertEquivalent(
        `
        export function test(): number {
          const obj = { x: 5, y: 0 };
          obj.x &&= 10;
          return obj.x;
        }
        `,
        [{ fn: "test", args: [] }],
      );
    });

    it("&&= keeps value when property is falsy", async () => {
      await assertEquivalent(
        `
        export function test(): number {
          const obj = { x: 0, y: 0 };
          obj.x &&= 10;
          return obj.x;
        }
        `,
        [{ fn: "test", args: [] }],
      );
    });

    it("||= assigns when property is falsy", async () => {
      await assertEquivalent(
        `
        export function test(): number {
          const obj = { x: 0, y: 0 };
          obj.x ||= 42;
          return obj.x;
        }
        `,
        [{ fn: "test", args: [] }],
      );
    });

    it("||= keeps value when property is truthy", async () => {
      await assertEquivalent(
        `
        export function test(): number {
          const obj = { x: 5, y: 0 };
          obj.x ||= 42;
          return obj.x;
        }
        `,
        [{ fn: "test", args: [] }],
      );
    });
  });

  describe("&&= ||= on element access (bracket notation)", () => {
    it("&&= on bracket access assigns when truthy", async () => {
      await assertEquivalent(
        `
        export function test(): number {
          const obj = { x: 5, y: 0 };
          obj["x"] &&= 10;
          return obj["x"];
        }
        `,
        [{ fn: "test", args: [] }],
      );
    });

    it("||= on bracket access assigns when falsy", async () => {
      await assertEquivalent(
        `
        export function test(): number {
          const obj = { x: 0, y: 0 };
          obj["x"] ||= 99;
          return obj["x"];
        }
        `,
        [{ fn: "test", args: [] }],
      );
    });
  });

  describe("compound assignment on property access", () => {
    it("+= on property access", async () => {
      await assertEquivalent(
        `
        export function test(): number {
          const obj = { x: 10, y: 0 };
          obj.x += 5;
          return obj.x;
        }
        `,
        [{ fn: "test", args: [] }],
      );
    });

    it("-= on property access", async () => {
      await assertEquivalent(
        `
        export function test(): number {
          const obj = { x: 10, y: 0 };
          obj.x -= 3;
          return obj.x;
        }
        `,
        [{ fn: "test", args: [] }],
      );
    });

    it("*= on property access", async () => {
      await assertEquivalent(
        `
        export function test(): number {
          const obj = { x: 4, y: 0 };
          obj.x *= 3;
          return obj.x;
        }
        `,
        [{ fn: "test", args: [] }],
      );
    });
  });

  describe("compound assignment on element access", () => {
    it("+= on bracket notation", async () => {
      await assertEquivalent(
        `
        export function test(): number {
          const obj = { x: 10, y: 0 };
          obj["x"] += 5;
          return obj["x"];
        }
        `,
        [{ fn: "test", args: [] }],
      );
    });
  });

  describe("short-circuit semantics", () => {
    it("&&= does not evaluate RHS when condition is falsy", async () => {
      await assertEquivalent(
        `
        let sideEffect = 0;
        function getSideEffect(): number {
          sideEffect = 1;
          return 42;
        }
        export function test(): number {
          const obj = { x: 0, y: 0 };
          obj.x &&= getSideEffect();
          return sideEffect;
        }
        `,
        [{ fn: "test", args: [] }],
      );
    });

    it("||= does not evaluate RHS when condition is truthy", async () => {
      await assertEquivalent(
        `
        let sideEffect = 0;
        function getSideEffect(): number {
          sideEffect = 1;
          return 42;
        }
        export function test(): number {
          const obj = { x: 5, y: 0 };
          obj.x ||= getSideEffect();
          return sideEffect;
        }
        `,
        [{ fn: "test", args: [] }],
      );
    });

    it("&&= evaluates RHS when condition is truthy", async () => {
      await assertEquivalent(
        `
        let sideEffect = 0;
        function getSideEffect(): number {
          sideEffect = 1;
          return 42;
        }
        export function test(): number {
          const obj = { x: 5, y: 0 };
          obj.x &&= getSideEffect();
          return obj.x;
        }
        `,
        [{ fn: "test", args: [] }],
      );
    });
  });

  describe("logical assignment result value", () => {
    it("&&= returns the assigned value when truthy", async () => {
      await assertEquivalent(
        `
        export function test(): number {
          const obj = { x: 5, y: 0 };
          const result = (obj.x &&= 10);
          return result;
        }
        `,
        [{ fn: "test", args: [] }],
      );
    });

    it("||= returns the existing value when truthy", async () => {
      await assertEquivalent(
        `
        export function test(): number {
          const obj = { x: 5, y: 0 };
          const result = (obj.x ||= 10);
          return result;
        }
        `,
        [{ fn: "test", args: [] }],
      );
    });
  });
});
