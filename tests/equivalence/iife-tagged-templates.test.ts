import { describe, it, expect } from "vitest";
import { compileToWasm, assertEquivalent } from "./helpers.js";

describe("IIFE and call expression tagged templates", () => {
  it("IIFE tagged template — function expression", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        return (function(strings: string[]): number {
          return strings.length;
        })\`hello\`;
      }
      `,
      [
        { fn: "test", args: [] },
      ],
    );
  });

  it("IIFE tagged template — function expression with substitutions", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        return (function(strings: string[], a: number, b: number): number {
          return strings.length + a + b;
        })\`hello \${10} world \${20}\`;
      }
      `,
      [
        { fn: "test", args: [] },
      ],
    );
  });

  it("IIFE tagged template — arrow function", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        return ((strings: string[]): number => strings.length)\`hello\`;
      }
      `,
      [
        { fn: "test", args: [] },
      ],
    );
  });

  it("call expression tagged template — function returning tag", async () => {
    await assertEquivalent(
      `
      function makeTag(): (strings: string[]) => number {
        return function(strings: string[]): number {
          return strings.length;
        };
      }
      export function test(): number {
        return makeTag()\`hello\`;
      }
      `,
      [
        { fn: "test", args: [] },
      ],
    );
  });

  it("call expression tagged template — with substitutions", async () => {
    await assertEquivalent(
      `
      function makeTag(): (strings: string[], val: number) => number {
        return function(strings: string[], val: number): number {
          return val;
        };
      }
      export function test(): number {
        return makeTag()\`prefix \${42} suffix\`;
      }
      `,
      [
        { fn: "test", args: [] },
      ],
    );
  });
});
