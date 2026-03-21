import { describe, it, expect } from "vitest";
import { compileToWasm, evaluateAsJs, assertEquivalent, buildImports, compile, readFileSync, resolve } from "./helpers.js";

describe("IIFE and call expression edge cases", () => {
  it("IIFE with no args", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        var result: number = 0;
        (function() {
          result = 42;
        })();
        return result;
      }
    `);
    expect(exports.test()).toBe(42);
  });

  it("IIFE with args and return value", async () => {
    await assertEquivalent(
      `
      export function test(a: number, b: number): number {
        return (function(x: number, y: number): number {
          return x + y;
        })(a, b);
      }
      `,
      [
        { fn: "test", args: [10, 20] },
        { fn: "test", args: [-5, 5] },
        { fn: "test", args: [0, 0] },
      ],
    );
  });

  it("IIFE captures outer variable (mutable)", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        var counter: number = 0;
        (function() {
          counter = counter + 10;
        })();
        return counter;
      }
    `);
    expect(exports.test()).toBe(10);
  });

  it("extra arguments are evaluated for side effects", async () => {
    await assertEquivalent(
      `
      var sideEffect: number = 0;
      function f(): number { return 1; }
      function g(): number { sideEffect = 99; return 5; }
      export function test(): number {
        f(g());
        return sideEffect;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("extra arguments to zero-param function", async () => {
    await assertEquivalent(
      `
      function f(): number { return 42; }
      export function test(): number {
        return f(1, 2, 3);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });


  // === Tests from #218-219 ===


  // --- Issue #218: Boolean(x = 0) should return false ---
  it("Boolean with assignment expression argument", async () => {
    await assertEquivalent(
      `
      export function test1(): number {
        var x: number = 5;
        return Boolean(x = 0) ? 1 : 0;
      }
      export function test2(): number {
        var x: number = 5;
        return Boolean(x = 1) ? 1 : 0;
      }
      export function test3(): number {
        var x: number = 0;
        return Boolean(x = 42) ? 1 : 0;
      }
      `,
      [
        { fn: "test1", args: [] },
        { fn: "test2", args: [] },
        { fn: "test3", args: [] },
      ],
    );
  });

  it("Boolean with empty string argument", async () => {
    await assertEquivalent(
      `
      export function test1(): number {
        return Boolean("") ? 1 : 0;
      }
      export function test2(): number {
        return Boolean("hello") ? 1 : 0;
      }
      `,
      [
        { fn: "test1", args: [] },
        { fn: "test2", args: [] },
      ],
    );
  });

  // --- Issue #219: void expression edge cases ---
  it("void expression returns undefined-like", async () => {
    await assertEquivalent(
      `
      export function test1(): number {
        var x: number = 1;
        void x;
        return x;
      }
      export function test2(): number {
        var x: number = 0;
        void (x = 5);
        return x;
      }
      `,
      [
        { fn: "test1", args: [] },
        { fn: "test2", args: [] },
      ],
    );
  });

  // --- Issue #219: switch statement with various cases ---
  it("switch with multiple case values", async () => {
    await assertEquivalent(
      `
      export function test(x: number): number {
        var result: number = 0;
        switch (x) {
          case 0: result = 10; break;
          case 1: result = 20; break;
          case 2: result = 30; break;
          default: result = -1;
        }
        return result;
      }
      `,
      [
        { fn: "test", args: [0] },
        { fn: "test", args: [1] },
        { fn: "test", args: [2] },
        { fn: "test", args: [3] },
      ],
    );
  });

  // --- Issue #219: return statement edge cases ---
  it("return from nested if in function", async () => {
    await assertEquivalent(
      `
      function myfunc(x: number): number {
        if (x > 0) {
          return x * 2;
        }
        return -1;
      }
      export function test(): number {
        return myfunc(5) + myfunc(-1);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  // --- Issue #219: logical-and returning values ---
  it("logical-and with numeric operands", async () => {
    await assertEquivalent(
      `
      export function test1(): number { return (1 && 2) as number; }
      export function test2(): number { return (0 && 2) as number; }
      export function test3(): number { return (1 && 0) as number; }
      `,
      [
        { fn: "test1", args: [] },
        { fn: "test2", args: [] },
        { fn: "test3", args: [] },
      ],
    );
  });

  // --- Issue #219: logical-or returning values ---
  it("logical-or with numeric operands", async () => {
    await assertEquivalent(
      `
      export function test1(): number { return (1 || 2) as number; }
      export function test2(): number { return (0 || 2) as number; }
      export function test3(): number { return (0 || 0) as number; }
      `,
      [
        { fn: "test1", args: [] },
        { fn: "test2", args: [] },
        { fn: "test3", args: [] },
      ],
    );
  });

  // --- Issue #218: Boolean with NaN ---
  it("Boolean with NaN returns false", async () => {
    await assertEquivalent(
      `
      export function test1(): number { return Boolean(NaN) ? 1 : 0; }
      export function test2(): number { return Boolean(0) ? 1 : 0; }
      export function test3(): number { return Boolean(-0) ? 1 : 0; }
      export function test4(): number { return Boolean(1) ? 1 : 0; }
      export function test5(): number { return Boolean(-1) ? 1 : 0; }
      `,
      [
        { fn: "test1", args: [] },
        { fn: "test2", args: [] },
        { fn: "test3", args: [] },
        { fn: "test4", args: [] },
        { fn: "test5", args: [] },
      ],
    );
  });

  // --- Issue #218: Boolean with assignment side effects ---
  it("Boolean assignment side effects preserved", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var x: number = 10;
        var b: boolean = Boolean(x = 0);
        // x should be 0 (side effect) and b should be false
        return x + (b ? 100 : 0);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  // === Tests from #210 ===


  it("for-of with object destructuring", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let sum = 0;
        const arr: {x: number, y: number}[] = [{x: 1, y: 2}, {x: 3, y: 4}];
        for (const {x, y} of arr) {
          sum = sum + x + y;
        }
        return sum;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("for-of with object destructuring and default values", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let sum = 0;
        const arr: {x: number}[] = [{x: 10}, {x: 20}];
        for (const {x} of arr) {
          sum = sum + x;
        }
        return sum;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("for-of destructuring with var", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let result = 0;
        const items: {a: number, b: number}[] = [{a: 5, b: 3}, {a: 7, b: 2}];
        for (var {a, b} of items) {
          result = result + a * b;
        }
        return result;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  // === Issue #246: for-of object destructuring with missing properties ===

  it("for-of destructuring missing property with default value", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let result = 0;
        const arr: {y: number}[] = [{y: 2}];
        for (const {x = 1} of arr) {
          result = x;
        }
        return result;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("for-of destructuring some fields present some missing", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let result = 0;
        const arr: {a: number}[] = [{a: 10}];
        for (const {a, b = 5} of arr) {
          result = a + b;
        }
        return result;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("for-of destructuring field exists with default, value takes precedence", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let result = 0;
        const arr: {x: number}[] = [{x: 42}];
        for (const {x = 99} of arr) {
          result = x;
        }
        return result;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  // === Tests from #211 ===


  it("void function returns undefined (=== undefined)", async () => {
    await assertEquivalent(
      `
      function voidFunc(): void {
      }
      export function test(): number {
        // void function call compared to undefined should be equal
        if (voidFunc() === undefined) return 1;
        return 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("void function with bare return returns undefined", async () => {
    await assertEquivalent(
      `
      let x: number = 0;
      function voidFunc(): void {
        x = 1;
        return;
      }
      export function test(): number {
        if (voidFunc() !== undefined) return 0;
        if (x !== 1) return 0;
        return 1;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("function.length property (formal parameter count)", async () => {
    await assertEquivalent(
      `
      function zero(): void {}
      function one(a: number): number { return a; }
      function three(a: number, b: number, c: number): number { return a + b + c; }
      export function test(): number {
        return zero.length * 100 + one.length * 10 + three.length;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("pass-by-value semantics for primitives", async () => {
    await assertEquivalent(
      `
      function modify(arg1: number): void {
        arg1++;
      }
      export function test(): number {
        let x: number = 1;
        modify(x);
        return x;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  // === Tests from #212 ===

  it("tagged template literals — same call site returns same object across calls", async () => {
    await assertEquivalent(
      `
      function eq(a: string[], b: string[]): number {
        return a === b ? 1 : 0;
      }
      function tag(strings: string[]): string[] {
        return strings;
      }
      function getTemplate(): string[] {
        return tag\`hello\`;
      }
      export function test1(): number {
        const first = getTemplate();
        const second = getTemplate();
        return eq(first, second);
      }
      `,
      [
        { fn: "test1", args: [] },
      ],
    );
  });

  it("tagged template literals — different sites produce different objects", async () => {
    await assertEquivalent(
      `
      function eq(a: string[], b: string[]): number {
        return a === b ? 1 : 0;
      }
      function tag(strings: string[]): string[] {
        return strings;
      }
      export function test1(): number {
        const first = tag\`aaa\`;
        const second = tag\`bbb\`;
        return eq(first, second);
      }
      `,
      [
        { fn: "test1", args: [] },
      ],
    );
  });

  it("tagged template literals — same site caches even with different expression values", async () => {
    await assertEquivalent(
      `
      function eq(a: string[], b: string[]): number {
        return a === b ? 1 : 0;
      }
      function tag(strings: string[], ...subs: number[]): string[] {
        return strings;
      }
      function getTemplate(x: number): string[] {
        return tag\`head\${x}tail\`;
      }
      export function test1(): number {
        const first = getTemplate(1);
        const second = getTemplate(2);
        return eq(first, second);
      }
      `,
      [
        { fn: "test1", args: [] },
      ],
    );
  });


  // === Tests from #213 ===

  // === Tests from #207-208 ===


  // -- Issue #208: computed property names with expressions --

  it("computed property name with addition expression", async () => {
    await assertEquivalent(
      `
      const key = "he" + "llo";
      const obj: { hello: number } = { [key]: 42 };
      export function test(): number {
        return obj.hello;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("computed property name with ternary expression", async () => {
    await assertEquivalent(
      `
      const flag = 1;
      const obj: { yes: number } = { [flag ? "yes" : "no"]: 10 };
      export function test(): number {
        return obj.yes;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("computed property name with template literal", async () => {
    await assertEquivalent(
      `
      const part = "val";
      const obj: { myval: number } = { [\`my\${part}\`]: 77 };
      export function test(): number {
        return obj.myval;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("computed property name with numeric expression", async () => {
    await assertEquivalent(
      `
      const arr: number[] = [0, 0, 0];
      arr[1 + 1] = 99;
      export function test(): number {
        return arr[2];
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("computed property name with const variable expression", async () => {
    await assertEquivalent(
      `
      const a = "hel";
      const b = "lo";
      const key = a + b;
      const obj: { hello: number } = { [key]: 55 };
      export function test(): number {
        return obj.hello;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  // === Tests from #209-217 ===


  // Issue #209: for-loop with continue and string concatenation of numbers
  it("for-loop continue with string concat", async () => {
    await assertEquivalent(
      `
      export function test(): string {
        var __str = "";
        for (var index = 0; index < 10; index += 1) {
          if (index < 5) continue;
          __str += index;
        }
        return __str;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("for-loop continue with string concat (all iterations)", async () => {
    await assertEquivalent(
      `
      export function test(): string {
        var s = "";
        for (var i = 0; i < 5; i++) {
          if (i === 2) continue;
          s += i;
        }
        return s;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  // Issue #209: for-loop with string literal as condition
  it("for-loop with string literal condition", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var accessed: number = 0;
        for (var i = 0; "hello"; ) {
          accessed = 1;
          break;
        }
        return accessed;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  // Issue #209: for-loop with object as condition
  it("for-loop with object condition", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var accessed: number = 0;
        var obj = { value: false };
        for (var i = 0; obj; ) {
          accessed = 1;
          break;
        }
        return accessed;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  // Issue #209: for-loop with number literal condition (non-boolean)
  it("for-loop with numeric literal condition", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var accessed: number = 0;
        for (var i = 0; 2; ) {
          accessed = 1;
          break;
        }
        return accessed;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  // Issue #217: while/do-while with string truthiness in loop condition
  it("while loop with string condition", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var s: string = "hello";
        var count: number = 0;
        while (s) {
          count++;
          if (count >= 3) s = "";
        }
        return count;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("do-while loop with string concatenation condition", async () => {
    await assertEquivalent(
      `
      export function test(): string {
        var result: string = "";
        var i: number = 0;
        do {
          result += i;
          i++;
        } while (i < 3);
        return result;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  // Issue #217: while loop with string variable condition
  it("while loop with string variable truthiness", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var s: string = "abc";
        var n: number = 0;
        while (s) {
          n++;
          s = "";
        }
        return n;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  // Issue #217: do-while with string condition
  it("do-while with string truthiness condition", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var s: string = "x";
        var n: number = 0;
        do {
          n++;
          if (n >= 2) s = "";
        } while (s);
        return n;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  // Issue #209: for-loop with string condition (test262 pattern - module level)
  it("for-loop with string condition - module level vars", async () => {
    const exports = await compileToWasm(`
let __fail: number = 0;

function assert_true(value: number): void {
  if (!value) {
    __fail = 1;
  }
}

export function test(): number {
  var accessed: number = 0;
  for (var i = 0; "undefined"; ) {
    accessed = 1;
    break;
  }
  assert_true(accessed);
  if (__fail) { return 0; }
  return 1;
}
    `);
    expect(exports.test!()).toBe(1);
  });

  // Issue #209: for-loop with object condition (test262 pattern)
  it("for-loop with object condition - assert pattern", async () => {
    const exports = await compileToWasm(`
let __fail: number = 0;

function assert_true(value: number): void {
  if (!value) {
    __fail = 1;
  }
}

export function test(): number {
  var accessed = false;
  var obj = { value: false };
  for (var i = 0; obj; ) {
    accessed = true;
    break;
  }
  if (!accessed) { __fail = 1; }
  if (__fail) { return 0; }
  return 1;
}
    `);
    expect(exports.test!()).toBe(1);
  });

  // Issue #209: for-loop with assert_true(boolean, string) - extra arg pattern
  it("for-loop assert_true with extra string arg", async () => {
    const exports = await compileToWasm(`
let __fail: number = 0;

function assert_true(value: number): void {
  if (!value) {
    __fail = 1;
  }
}

export function test(): number {
  var accessed = false;
  var obj = { value: false };
  for (var i = 0; obj; ) {
    accessed = true;
    break;
  }
  assert_true(accessed, 'accessed !== true');
  if (__fail) { return 0; }
  return 1;
}
    `);
    expect(exports.test!()).toBe(1);
  });

  // Exact test262 wrapper pattern for 12.6.3_2-3-a-ii-19 (string condition "undefined")
  it("test262 for-loop string condition pattern", async () => {
    const exports = await compileToWasm(`
let __fail: number = 0;

function isSameValue(a: number, b: number): number {
  if (a === b) { return 1; }
  if (a !== a && b !== b) { return 1; }
  return 0;
}

function assert_sameValue(actual: number, expected: number): void {
  if (!isSameValue(actual, expected)) {
    __fail = 1;
  }
}

function assert_notSameValue(actual: number, expected: number): void {
  if (isSameValue(actual, expected)) {
    __fail = 1;
  }
}

function assert_true(value: number): void {
  if (!value) {
    __fail = 1;
  }
}

export function test(): number {
  var accessed = false;
  for (var i = 0; "undefined"; ) {
    accessed = true;
    break;
  }
  assert_true(accessed, 'accessed !== true');
  if (__fail) { return 0; }
  return 1;
}
    `);
    expect(exports.test!()).toBe(1);
  });

  // Issue #209: untyped var string concat (test262 pattern: var __str; __str=""; __str+=index)
  it("untyped var string concat with continue", async () => {
    await assertEquivalent(
      `
      export function test(): string {
        var __str: any, index: any;
        __str = "";
        for (index = 0; index < 10; index += 1) {
          if (index < 5) continue;
          __str += index;
        }
        return __str;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  // Labeled block break (non-loop labeled statement)
  it("labeled block break exits block", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var i: number = 0;
        outer: {
          while (true) {
            i++;
            if (i === 10) {
              break outer;
            }
          }
          i = 999; // should not be reached
        }
        return i;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  // Labeled block break with do-while
  it("labeled block break from do-while", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var i: number = 0;
        outer: {
          do {
            i++;
            if (i === 5) break outer;
          } while (true);
          i = 999;
        }
        return i;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  // === Tests from #214-215-216 ===

  // === Tests from #221 ===


  it("comma operator indirect call: (0, fn)()", async () => {
    await assertEquivalent(
      `
      function add(a: number, b: number): number { return a + b; }
      export function test(): number {
        return (0, add)(3, 4);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("comma operator indirect call with side effects", async () => {
    await assertEquivalent(
      `
      var counter: number = 0;
      function inc(): number { counter = counter + 1; return counter; }
      function double(x: number): number { return x * 2; }
      export function test(): number {
        const result = (inc(), double)(5);
        return result + counter;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("fn.call() with thisArg dropped", async () => {
    await assertEquivalent(
      `
      function add(a: number, b: number): number { return a + b; }
      export function test(): number {
        return add.call(null, 10, 20);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("fn.call() with no extra args", async () => {
    await assertEquivalent(
      `
      function getFortyTwo(): number { return 42; }
      export function test(): number {
        return getFortyTwo.call(null);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("fn.call() with undefined thisArg", async () => {
    await assertEquivalent(
      `
      function multiply(a: number, b: number): number { return a * b; }
      export function test(): number {
        return multiply.call(undefined, 6, 7);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("chained method call on returned value", async () => {
    await assertEquivalent(
      `
      class Builder {
        value: number;
        constructor(v: number) { this.value = v; }
        add(n: number): Builder { return new Builder(this.value + n); }
        result(): number { return this.value; }
      }
      function makeBuilder(): Builder { return new Builder(0); }
      export function test(): number {
        return makeBuilder().add(10).add(20).result();
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  // === Tests from #222 ===


  it("object destructuring var hoisting", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var obj = { x: 10, y: 20 };
        var { x, y } = obj;
        return x + y;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("array destructuring var hoisting", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var arr: number[] = [3, 7];
        var [a, b] = arr;
        return a + b;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("var in nested block is accessible after block", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var result = 0;
        if (true) {
          var x = 42;
          result = x;
        }
        return result;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("var in for-loop body is hoisted", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        for (var i = 0; i < 3; i++) {
          var x = i * 10;
        }
        return x;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  // === Tests from #223-224 ===


  // --- Issue #223: Computed property names in class declarations ---

  it("class with string literal computed property name", async () => {
    await assertEquivalent(
      `
      class Counter {
        ["count"]: number;
        constructor() {
          this.count = 0;
        }
        ["increment"](): number {
          this.count = this.count + 1;
          return this.count;
        }
      }
      export function test(): number {
        const c = new Counter();
        c.increment();
        c.increment();
        return c.count;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("class with numeric literal computed property name", async () => {
    const exports = await compileToWasm(`
      class Data {
        ["value"]: number;
        constructor(v: number) {
          this.value = v;
        }
        ["double"](): number {
          return this.value * 2;
        }
      }
      export function test(n: number): number {
        const d = new Data(n);
        return d.double();
      }
    `);
    expect(exports.test(21)).toBe(42);
    expect(exports.test(5)).toBe(10);
  });

  // --- Issue #224: Prefix/postfix increment/decrement on member expressions ---

  it("prefix increment on object property", async () => {
    await assertEquivalent(
      `
      class Box {
        value: number;
        constructor(v: number) {
          this.value = v;
        }
      }
      export function test(): number {
        const b = new Box(10);
        const result = ++b.value;
        return result;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("prefix decrement on object property", async () => {
    await assertEquivalent(
      `
      class Box {
        value: number;
        constructor(v: number) {
          this.value = v;
        }
      }
      export function test(): number {
        const b = new Box(10);
        --b.value;
        return b.value;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("postfix increment on object property", async () => {
    await assertEquivalent(
      `
      class Box {
        value: number;
        constructor(v: number) {
          this.value = v;
        }
      }
      export function test(): number {
        const b = new Box(10);
        const old = b.value++;
        return old;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("postfix increment stores new value", async () => {
    await assertEquivalent(
      `
      class Box {
        value: number;
        constructor(v: number) {
          this.value = v;
        }
      }
      export function test(): number {
        const b = new Box(10);
        b.value++;
        return b.value;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("postfix decrement on object property", async () => {
    await assertEquivalent(
      `
      class Box {
        value: number;
        constructor(v: number) {
          this.value = v;
        }
      }
      export function test(): number {
        const b = new Box(10);
        const old = b.value--;
        return old;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("multiple increments on object property", async () => {
    await assertEquivalent(
      `
      class Counter {
        count: number;
        constructor() {
          this.count = 0;
        }
      }
      export function test(): number {
        const c = new Counter();
        ++c.count;
        ++c.count;
        c.count++;
        return c.count;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("array element increment", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const arr: number[] = [10, 20, 30];
        arr[1]++;
        return arr[1];
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("prefix increment on array element", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const arr: number[] = [10, 20, 30];
        const result = ++arr[0];
        return result;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("IIFE returning boolean inside f64-returning function (#720)", async () => {
    // The IIFE returns boolean (i32), but the outer function returns number (f64).
    // Previously the compiler coerced the IIFE return value to f64 (for the outer
    // function's return type) before storing it in the i32 IIFE result local,
    // causing a Wasm validation error: local.set expected i32, found f64.
    await assertEquivalent(
      `
      export function test(): number {
        var x: number = (function(): boolean {
          return 5 > 3;
        })() ? 1 : 0;
        return x;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("IIFE returning boolean used as condition (#720)", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        if ((function(): boolean { return 10 !== 0; })()) {
          return 1;
        }
        return 0;
      }
    `);
    expect(exports.test()).toBe(1);
  });
});
