import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "./equivalence/helpers.js";

async function run(source: string): Promise<Record<string, unknown>> {
  const result = compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
  const { instance } = await WebAssembly.instantiate(
    result.binary,
    buildImports(result),
  );
  return instance.exports as Record<string, unknown>;
}

describe("struct type errors (#624)", () => {
  it("class struct type is not corrupted by dynamic field addition from prototype access", async () => {
    // Regression: accessing C.prototype['x'] was dynamically adding 'prototype'
    // as a field to the class struct type, causing struct.new field count mismatch
    // because the constructor only pushes values for fields known at collection time.
    const exports = await run(`
      class C {
        x: number;
        constructor(x: number) { this.x = x; }
        getX(): number { return this.x; }
      }
      export function test(): number {
        var c = new C(42);
        return c.getX();
      }
    `);
    expect((exports.test as Function)()).toBe(42);
  });

  it("anonymous class expression with getter/setter compiles without extra fields", async () => {
    const exports = await run(`
      var C = class {
        get x(): number { return 42; }
        set x(v: number) { }
      };
      export function test(): number {
        var c = new C();
        return c.x;
      }
    `);
    expect((exports.test as Function)()).toBe(42);
  });

  it("class with getter and data field", async () => {
    const exports = await run(`
      class Point {
        x: number;
        y: number;
        constructor(x: number, y: number) {
          this.x = x;
          this.y = y;
        }
        get sum(): number { return this.x + this.y; }
      }
      export function test(): number {
        var p = new Point(3, 4);
        return p.sum;
      }
    `);
    expect((exports.test as Function)()).toBe(7);
  });

  it("child class extends parent with correct struct fields", async () => {
    const exports = await run(`
      class Animal {
        name: string;
        constructor(name: string) {
          this.name = name;
        }
        greet(): string { return this.name; }
      }
      class Dog extends Animal {
        breed: string;
        constructor(name: string, breed: string) {
          super(name);
          this.breed = breed;
        }
      }
      export function test(): string {
        var d = new Dog("Rex", "Lab");
        return d.greet();
      }
    `);
    expect((exports.test as Function)()).toBe("Rex");
  });

  it("class with no constructor and property declarations", async () => {
    const exports = await run(`
      class Simple {
        x: number = 10;
      }
      export function test(): number {
        var e = new Simple();
        return e.x;
      }
    `);
    expect((exports.test as Function)()).toBe(10);
  });

  it("class with methods only (no fields) compiles correctly", async () => {
    const exports = await run(`
      class Greeter {
        greet(): number { return 42; }
      }
      export function test(): number {
        var g = new Greeter();
        return g.greet();
      }
    `);
    expect((exports.test as Function)()).toBe(42);
  });
});
