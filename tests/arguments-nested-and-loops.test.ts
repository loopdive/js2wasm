import { describe, it, expect } from "vitest";
import { compileToWasm, evaluateAsJs, assertEquivalent, buildImports, compile, readFileSync, resolve } from "./helpers.js";

describe("Arguments object in nested functions (#211)", () => {
  it("arguments.length in nested function", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        function inner(a: number, b: number, c: number): number {
          return arguments.length;
        }
        return inner(1, 2, 3);
      }
    `);
    expect(exports.test()).toBe(3);
  });

  it("for-loop with continue", async () => {
    await assertEquivalent(
      `
      export function test(): string {
        let s = "";
        for (let i = 0; i < 10; i++) {
          if (i < 5) continue;
          s += i;
        }
        return s;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("for-loop with break", async () => {
    await assertEquivalent(
      `
      export function test(): string {
        let s = "";
        for (let i = 0; i < 10; i++) {
          if (i > 5) break;
          s += i;
        }
        return s;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("nested for-loop with labeled continue", async () => {
    await assertEquivalent(
      `
      export function test(): string {
        let s = "";
        outer: for (let i = 0; i < 4; i++) {
          inner: for (let j = 0; j <= i; j++) {
            if (i * j === 6) continue outer;
            s += "" + i + j;
          }
        }
        return s;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("nested for-loop with labeled break", async () => {
    await assertEquivalent(
      `
      export function test(): string {
        let s = "";
        outer: for (let i = 0; i < 4; i++) {
          inner: for (let j = 0; j <= i; j++) {
            if (i * j >= 4) break outer;
            s += "" + i + j;
          }
        }
        return s;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("while loop with complex condition", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let x = 10;
        let sum = 0;
        while (x > 0 && sum < 30) {
          sum += x;
          x -= 3;
        }
        return sum;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("do-while with continue", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let i = 0;
        let sum = 0;
        do {
          i++;
          if (i % 2 === 0) continue;
          sum += i;
        } while (i < 10);
        return sum;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("for-of destructuring object", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const items = [{ a: 1, b: 2 }, { a: 3, b: 4 }];
        let sum = 0;
        for (const { a, b } of items) {
          sum += a + b;
        }
        return sum;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });


  it("do-while with break", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let i = 0;
        let sum = 0;
        do {
          i++;
          sum += i;
          if (sum > 10) break;
        } while (i < 100);
        return sum;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("while loop with assignment in condition", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let arr = [1, 2, 3, 4, 5];
        let sum = 0;
        let i = 0;
        while (i < arr.length) {
          sum += arr[i];
          i++;
        }
        return sum;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("for-loop with function declaration in body", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let result = 0;
        for (let i = 0; i < 3; i++) {
          function addI(x: number): number { return x + i; }
          result += addI(10);
        }
        return result;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("nested for-loop continue interaction", async () => {
    await assertEquivalent(
      `
      export function test(): string {
        let s = "";
        for (let i = 0; i < 4; i++) {
          for (let j = 0; j <= i; j++) {
            if (i * j === 6) continue;
            s += "" + i + j;
          }
        }
        return s;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("for-of with simple variable", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const arr = [10, 20, 30];
        let sum = 0;
        for (const x of arr) {
          sum += x;
        }
        return sum;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });


  // Issue #200: JSON.stringify/parse with various argument types
  it("JSON.stringify with number", async () => {
    await assertEquivalent(
      `
      export function test(): string {
        return JSON.stringify(42);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("JSON.parse with string", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        return JSON.parse("42");
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  // Issue #205: String.prototype.indexOf with start position
  it("string indexOf with start position", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var s: string = "hello world hello";
        return s.indexOf("hello", 1);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("string indexOf without start position", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var s: string = "hello world";
        return s.indexOf("world");
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  // Issue #181: new Object()
  it("new Object() creates empty object", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        var o: any = new Object();
        return 42;
      }
    `);
    expect(exports.test()).toBe(42);
  });

  // Issue #251: super() call required in derived class constructors — diagnostic suppressed
  it("derived class without explicit super compiles", async () => {
    const exports = await compileToWasm(`
      class Base {
        getVal(): number { return 42; }
      }
      class Child extends Base {
        run(): number { return this.getVal(); }
      }
      export function test(): number {
        var c = new Child();
        return c.run();
      }
    `);
    expect(exports.test()).toBe(42);
  });

  // Issue #252: var re-declaration with different types
  it("var re-declaration with different value", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        var x: number = 1;
        var x: number = 42;
        return x;
      }
    `);
    expect(exports.test()).toBe(42);
  });

  // Issue #255: 'this' implicit any type in class methods
  it("this in class method compiles", async () => {
    const exports = await compileToWasm(`
      class Counter {
        count: number = 0;
        increment(): void {
          this.count = this.count + 1;
        }
        getCount(): number {
          return this.count;
        }
      }
      export function test(): number {
        var c = new Counter();
        c.increment();
        c.increment();
        return c.getCount();
      }
    `);
    expect(exports.test()).toBe(2);
  });

  // Issue #240: Setter with return value
  it("setter with return statement compiles", async () => {
    const exports = await compileToWasm(`
      class Box {
        _value: number = 0;
        get value(): number { return this._value; }
        set value(v: number) { this._value = v; }
      }
      export function test(): number {
        var b = new Box();
        b.value = 99;
        return b.value;
      }
    `);
    expect(exports.test()).toBe(99);
  });

  // Issue #225: string !== comparison with any-typed variable
  it("string !== comparison (any-typed var vs string literal)", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var s: string = "";
        for (var i: number = 0; i < 10; i += 1) {
          if (i < 5) continue;
          s += i;
        }
        if (s !== "56789") {
          return 0;
        }
        return 1;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  // Issue #225: string === comparison
  it("string === comparison (typed variables)", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let a: string = "hello";
        let b: string = "hel" + "lo";
        if (a === b) {
          return 1;
        }
        return 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  // Issue #225: string !== with loop-built string (test262 pattern)
  it("for-loop continue with string !== check", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var __str = "";
        for (var index = 0; index < 10; index += 1) {
          if (index < 5) continue;
          __str += index;
        }
        if (__str !== "56789") {
          return 0;
        }
        return 1;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  // Issue #245: switch statement with string case values
  it("switch with string case values", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let x: string = "b";
        let result: number = 0;
        switch (x) {
          case "a":
            result = 1;
            break;
          case "b":
            result = 2;
            break;
          case "c":
            result = 3;
            break;
          default:
            result = -1;
        }
        return result;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  // Issue #245: switch with string case values and fallthrough
  it("switch with string case values and fallthrough", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let x: string = "a";
        let result: number = 0;
        switch (x) {
          case "a":
            result += 1;
          case "b":
            result += 10;
            break;
          case "c":
            result += 100;
            break;
        }
        return result;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  // Issue #245: switch with string default case
  it("switch with string case values - default case", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let x: string = "z";
        let result: number = 0;
        switch (x) {
          case "a":
            result = 1;
            break;
          case "b":
            result = 2;
            break;
          default:
            result = 99;
        }
        return result;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  // Issue #256: nested function declarations in for loops
  it("nested function declaration in for loop body", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var result: number = 0;
        for (var i: number = 0; i < 3; i++) {
          function add10(): number { return 10; }
          result = result + add10();
        }
        return result;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  // Issue #256: nested function declarations in while loops
  it("nested function declaration in while loop body", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var count: number = 0;
        var done: boolean = false;
        while (!done) {
          function inc(): number { return 1; }
          count = count + inc();
          if (count >= 5) done = true;
        }
        return count;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  // Issue #256: nested function declarations in switch cases
  it("nested function declaration in switch case", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var x: number = 2;
        switch (x) {
          case 2: {
            function getVal(): number { return 99; }
            return getVal();
          }
          default:
            return 0;
        }
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  // Issue #256: nested function declaration in do-while loop
  it("nested function declaration in do-while loop", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var result: number = 0;
        var count: number = 0;
        do {
          function getInc(): number { return 7; }
          result = result + getInc();
          count = count + 1;
        } while (count < 2);
        return result;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  // Issue #248: Logical operators with null/undefined operands
  it("logical AND returns null when RHS is null (#248)", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        if ((true && null) !== null) return 0;
        return 1;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("logical OR returns null when RHS is null (#248)", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        if ((false || null) !== null) return 0;
        return 1;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  // Issue #226: valueOf coercion on comparison operators
  it("comparison operators invoke valueOf on object literals (#226)", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        var obj1 = {
          valueOf: function () { return 3; }
        };
        var obj2 = {
          valueOf: function () { return 5; }
        };
        let result = 0;
        if (obj1 < obj2) result += 1;
        if (obj1 > obj2) result += 10;
        if (obj1 <= obj2) result += 100;
        if (obj1 >= obj2) result += 1000;
        return result;
      }
    `);
    // 3 < 5: true (+1), 3 > 5: false, 3 <= 5: true (+100), 3 >= 5: false
    expect(exports.test()).toBe(101);
  });

  it("valueOf with captured variables (#226)", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        var accessed = false;
        var obj = {
          valueOf: function () {
            accessed = true;
            return 42;
          }
        };
        var obj2 = {
          valueOf: function () { return 10; }
        };
        if (!(obj > obj2)) return 0;
        if (!accessed) return 0;
        return 1;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  // ── Issue #247: Arithmetic with null/undefined ──

  it("null * null === 0 (#247)", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return (null as any) * (null as any);
      }
    `);
    expect(exports.test()).toBe(0);
  });

  it("null + null === 0 (#247)", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return (null as any) + (null as any);
      }
    `);
    expect(exports.test()).toBe(0);
  });

  it("null - null === 0 (#247)", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return (null as any) - (null as any);
      }
    `);
    expect(exports.test()).toBe(0);
  });

  it("undefined - undefined is NaN (literal) (#247)", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return (undefined as any) - (undefined as any);
      }
    `);
    expect(exports.test()).toBeNaN();
  });

  it("undefined * undefined is NaN (literal) (#247)", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return (undefined as any) * (undefined as any);
      }
    `);
    expect(exports.test()).toBeNaN();
  });

  it("null - undefined is NaN (#247)", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return (null as any) - (undefined as any);
      }
    `);
    expect(exports.test()).toBeNaN();
  });

  it("compound assignment with null literal (#247)", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        var x: number = 0;
        x *= (null as any);
        return x;
      }
    `);
    expect(exports.test()).toBe(0);
  });

  it("compound subtract undefined literal (#247)", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        var x: number = 5;
        x -= (undefined as any);
        return x;
      }
    `);
    expect(exports.test()).toBeNaN();
  });

  it("null / null is NaN (#247)", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return (null as any) / (null as any);
      }
    `);
    expect(exports.test()).toBeNaN();
  });

  it("undefined + null is NaN (#247)", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return (undefined as any) + (null as any);
      }
    `);
    expect(exports.test()).toBeNaN();
  });

});
