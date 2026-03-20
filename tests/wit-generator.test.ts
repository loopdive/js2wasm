import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

describe("WIT generator", () => {
  it("generates WIT for exported functions with primitive types", () => {
    const result = compile(
      `
      export function add(a: number, b: number): number {
        return a + b;
      }
      export function greet(name: string): string {
        return "Hello, " + name;
      }
      export function isEven(n: number): boolean {
        return n % 2 === 0;
      }
      export function doWork(): void {}
      `,
      { wit: true },
    );

    expect(result.success).toBe(true);
    expect(result.wit).toBeDefined();
    const wit = result.wit!;

    // Should have package declaration
    expect(wit).toContain("package local:module;");
    // Should have world
    expect(wit).toContain("world module {");

    // Should map number -> f64
    expect(wit).toContain("export add: func(a: f64, b: f64) -> f64;");
    // Should map string -> string
    expect(wit).toContain("export greet: func(name: string) -> string;");
    // Should map boolean -> bool
    expect(wit).toContain("export is-even: func(n: f64) -> bool;");
    // void return -> no return type
    expect(wit).toContain("export do-work: func();");
  });

  it("generates WIT records from exported interfaces", () => {
    const result = compile(
      `
      export interface Point {
        x: number;
        y: number;
      }
      export function distance(a: Point, b: Point): number {
        return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
      }
      `,
      { wit: true },
    );

    expect(result.success).toBe(true);
    const wit = result.wit!;

    // Should generate a record for Point
    expect(wit).toContain("record point {");
    expect(wit).toContain("x: f64,");
    expect(wit).toContain("y: f64,");

    // Function should reference the record type
    expect(wit).toContain("export distance: func(a: point, b: point) -> f64;");
  });

  it("generates WIT records from exported type aliases", () => {
    const result = compile(
      `
      export type Config = {
        width: number;
        height: number;
        title: string;
      };
      export function createWindow(config: Config): boolean {
        return true;
      }
      `,
      { wit: true },
    );

    expect(result.success).toBe(true);
    const wit = result.wit!;

    // Should generate a record for Config
    expect(wit).toContain("record config {");
    expect(wit).toContain("width: f64,");
    expect(wit).toContain("height: f64,");
    expect(wit).toContain("title: string,");
  });

  it("maps array types to list<T>", () => {
    const result = compile(
      `
      export function sum(nums: number[]): number {
        let total = 0;
        for (let i = 0; i < nums.length; i++) total += nums[i];
        return total;
      }
      export function concat(strs: string[]): string {
        return strs.join("");
      }
      `,
      { wit: true },
    );

    expect(result.success).toBe(true);
    const wit = result.wit!;

    expect(wit).toContain("export sum: func(nums: list<f64>) -> f64;");
    expect(wit).toContain("export concat: func(strs: list<string>) -> string;");
  });

  it("maps nullable types to option<T>", () => {
    const result = compile(
      `
      export function find(id: number): string | null {
        return null;
      }
      `,
      { wit: true },
    );

    expect(result.success).toBe(true);
    const wit = result.wit!;

    expect(wit).toContain("export find: func(id: f64) -> option<string>;");
  });

  it("uses camelCase to kebab-case conversion", () => {
    const result = compile(
      `
      export function getUserName(userId: number): string {
        return "test";
      }
      `,
      { wit: true },
    );

    expect(result.success).toBe(true);
    const wit = result.wit!;

    expect(wit).toContain("export get-user-name: func(user-id: f64) -> string;");
  });

  it("supports custom package and world names", () => {
    const result = compile(
      `
      export function hello(): string { return "hi"; }
      `,
      { wit: { packageName: "myorg:mypackage", worldName: "my-world" } },
    );

    expect(result.success).toBe(true);
    const wit = result.wit!;

    expect(wit).toContain("package myorg:mypackage;");
    expect(wit).toContain("world my-world {");
  });

  it("does not include wit when option is not set", () => {
    const result = compile(
      `export function add(a: number, b: number): number { return a + b; }`,
    );

    expect(result.success).toBe(true);
    expect(result.wit).toBeUndefined();
  });

  it("skips non-exported functions", () => {
    const result = compile(
      `
      function helper(): number { return 42; }
      export function main(): number { return helper(); }
      `,
      { wit: true },
    );

    expect(result.success).toBe(true);
    const wit = result.wit!;

    // Should only include exported function
    expect(wit).toContain("export main: func() -> f64;");
    // Should not include helper
    expect(wit).not.toContain("helper");
  });
});
