import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function run(source: string, fn: string, args: unknown[] = []): Promise<unknown> {
  const result = compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
  const { instance } = await WebAssembly.instantiate(result.binary, { env: {} });
  return (instance.exports as any)[fn](...args);
}

describe("abstract classes", () => {
  it("abstract class with concrete method inherited by subclass", async () => {
    expect(
      await run(
        `
      abstract class Animal {
        legs: number;
        constructor(legs: number) {
          this.legs = legs;
        }
        getLegs(): number {
          return this.legs;
        }
      }
      class Dog extends Animal {
        constructor() {
          super(4);
        }
      }
      export function test(): number {
        const d = new Dog();
        return d.getLegs();
      }
    `,
        "test",
      ),
    ).toBe(4);
  });

  it("abstract method overridden by subclass", async () => {
    expect(
      await run(
        `
      abstract class Shape {
        sides: number;
        constructor(sides: number) {
          this.sides = sides;
        }
        abstract area(): number;
      }
      class Square extends Shape {
        size: number;
        constructor(size: number) {
          super(4);
          this.size = size;
        }
        area(): number {
          return this.size * this.size;
        }
      }
      export function test(): number {
        const s = new Square(5);
        return s.area();
      }
    `,
        "test",
      ),
    ).toBe(25);
  });

  it("abstract class with mixed concrete and abstract methods", async () => {
    expect(
      await run(
        `
      abstract class Vehicle {
        speed: number;
        constructor(speed: number) {
          this.speed = speed;
        }
        getSpeed(): number {
          return this.speed;
        }
        abstract fuelCost(): number;
      }
      class Car extends Vehicle {
        constructor(speed: number) {
          super(speed);
        }
        fuelCost(): number {
          return this.speed * 2;
        }
      }
      export function test(): number {
        const c = new Car(60);
        return c.getSpeed() + c.fuelCost();
      }
    `,
        "test",
      ),
    ).toBe(180);
  });

  it("multiple levels of abstraction", async () => {
    expect(
      await run(
        `
      abstract class Base {
        x: number;
        constructor(x: number) {
          this.x = x;
        }
        abstract compute(): number;
      }
      abstract class Middle extends Base {
        y: number;
        constructor(x: number, y: number) {
          super(x);
          this.y = y;
        }
        getSum(): number {
          return this.x + this.y;
        }
      }
      class Concrete extends Middle {
        z: number;
        constructor(x: number, y: number, z: number) {
          super(x, y);
          this.z = z;
        }
        compute(): number {
          return this.getSum() + this.z;
        }
      }
      export function test(): number {
        const c = new Concrete(10, 20, 30);
        return c.compute();
      }
    `,
        "test",
      ),
    ).toBe(60);
  });

  it("abstract class with no explicit constructor", async () => {
    // Abstract class with no constructor — subclass provides constructor
    expect(
      await run(
        `
      abstract class Named {
        name: number;
        constructor(name: number) {
          this.name = name;
        }
        abstract getValue(): number;
      }
      class Impl extends Named {
        val: number;
        constructor(name: number, val: number) {
          super(name);
          this.val = val;
        }
        getValue(): number {
          return this.name + this.val;
        }
      }
      export function test(): number {
        const x = new Impl(10, 20);
        return x.getValue();
      }
    `,
        "test",
      ),
    ).toBe(30);
  });

  it("abstract class with multiple abstract methods", async () => {
    expect(
      await run(
        `
      abstract class Calculator {
        value: number;
        constructor(v: number) {
          this.value = v;
        }
        abstract add(n: number): number;
        abstract multiply(n: number): number;
      }
      class SimpleCalc extends Calculator {
        constructor(v: number) {
          super(v);
        }
        add(n: number): number {
          return this.value + n;
        }
        multiply(n: number): number {
          return this.value * n;
        }
      }
      export function test(): number {
        const c = new SimpleCalc(10);
        return c.add(5) + c.multiply(3);
      }
    `,
        "test",
      ),
    ).toBe(45);
  });
});
