import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function compileAndRun(source: string) {
  const result = compile(source, { fileName: "test.ts" });
  if (!result.binary || result.binary.length === 0) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`,
    );
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return instance.exports as Record<string, Function>;
}

function compileOnly(source: string) {
  const result = compile(source, { fileName: "test.ts" });
  return result;
}

describe("issue-146: unknown identifier errors from scope/hoisting issues", () => {
  it("catch clause variable is in scope within catch body", async () => {
    const result = compileOnly(`
      export function test(): number {
        try {
          throw 42;
        } catch (e) {
          return 1;
        }
        return 0;
      }
    `);
    const unknownIdErrors = result.errors.filter((e) =>
      e.message.includes("Unknown identifier"),
    );
    expect(unknownIdErrors).toEqual([]);
  });

  it("var declared in catch block is accessible outside", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        try {
          throw 1;
        } catch (err) {
          var x: number = 10;
        }
        return x;
      }
    `);
    expect(e.test()).toBe(10);
  });

  it("for-loop let variable is in scope within loop body", async () => {
    const result = compileOnly(`
      export function test(): number {
        let sum: number = 0;
        for (let i: number = 0; i < 5; i++) {
          sum = sum + i;
        }
        return sum;
      }
    `);
    const unknownIdErrors = result.errors.filter((e) =>
      e.message.includes("Unknown identifier"),
    );
    expect(unknownIdErrors).toEqual([]);
  });

  it("for-loop var initializer variable accessible in loop body and after", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        for (var i: number = 0; i < 5; i++) {
          var sum: number = i;
        }
        return i + sum;
      }
    `);
    expect(e.test()).toBe(5 + 4);
  });

  it("function declaration hoisted to enclosing function scope", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        var x: number = add(2, 3);
        function add(a: number, b: number): number {
          return a + b;
        }
        return x;
      }
    `);
    expect(e.test()).toBe(5);
  });

  it("function declaration inside if-block hoisted to function scope", async () => {
    const result = compileOnly(`
      export function test(): number {
        if (true) {
          function inner(): number { return 42; }
        }
        return inner();
      }
    `);
    const unknownIdErrors = result.errors.filter((e) =>
      e.message.includes("Unknown identifier"),
    );
    expect(unknownIdErrors).toEqual([]);
  });

  it("var declared inside while loop hoisted to function scope", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        var count: number = 0;
        while (count < 3) {
          var x: number = count;
          count = count + 1;
        }
        return x;
      }
    `);
    expect(e.test()).toBe(2);
  });

  it("multiple var declarations in different blocks share same scope", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        if (true) {
          var a: number = 1;
        }
        if (true) {
          var b: number = 2;
        }
        return a + b;
      }
    `);
    expect(e.test()).toBe(3);
  });

  it("var in switch case hoisted to function scope", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        var val: number = 1;
        switch (val) {
          case 1:
            var result: number = 10;
            break;
          default:
            var result2: number = 20;
        }
        return result;
      }
    `);
    expect(e.test()).toBe(10);
  });

  it("let in for-loop initializer scoped to loop body", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        let total: number = 0;
        for (let j: number = 0; j < 3; j++) {
          total = total + j;
        }
        return total;
      }
    `);
    expect(e.test()).toBe(3);
  });

  it("var in try block hoisted to function scope", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        try {
          var x: number = 42;
        } catch (e) {
        }
        return x;
      }
    `);
    expect(e.test()).toBe(42);
  });

  it("var in finally block hoisted to function scope", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        try {
        } catch (e) {
        } finally {
          var x: number = 99;
        }
        return x;
      }
    `);
    expect(e.test()).toBe(99);
  });

  it("nested function declarations hoisted", async () => {
    const result = compileOnly(`
      export function test(): number {
        var r: number = outer();
        function outer(): number {
          return inner();
          function inner(): number {
            return 42;
          }
        }
        return r;
      }
    `);
    const unknownIdErrors = result.errors.filter((e) =>
      e.message.includes("Unknown identifier"),
    );
    expect(unknownIdErrors).toEqual([]);
  });

  it("for-loop with let initializer - variable used in condition and body", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        let sum: number = 0;
        for (let i: number = 1; i <= 4; i++) {
          sum = sum + i;
        }
        return sum;
      }
    `);
    expect(e.test()).toBe(10);
  });

  it("let/const in for-loop initializer available in loop body", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        let result: number = 0;
        for (let i: number = 0; i < 3; i++) {
          let doubled: number = i * 2;
          result = result + doubled;
        }
        return result;
      }
    `);
    expect(e.test()).toBe(6);
  });

  it("catch variable used in expressions inside catch block", async () => {
    const result = compileOnly(`
      export function test(): number {
        try {
          return 1;
        } catch (e) {
          var x: number = 0;
          return x;
        }
        return 0;
      }
    `);
    const unknownIdErrors = result.errors.filter((e) =>
      e.message.includes("Unknown identifier"),
    );
    expect(unknownIdErrors).toEqual([]);
  });

  it("var hoisting across labeled statements", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        label1: {
          var x: number = 5;
          break label1;
        }
        return x;
      }
    `);
    expect(e.test()).toBe(5);
  });

  it("module-level var inside for loop hoisted as module global", async () => {
    const result = compileOnly(`
      for (var i: number = 0; i < 3; i++) {
      }
      export function test(): number {
        return i;
      }
    `);
    const unknownIdErrors = result.errors.filter((e) =>
      e.message.includes("Unknown identifier"),
    );
    expect(unknownIdErrors).toEqual([]);
  });

  it("module-level var inside if block hoisted as module global", async () => {
    const result = compileOnly(`
      if (true) {
        var y: number = 42;
      }
      export function test(): number {
        return y;
      }
    `);
    const unknownIdErrors = result.errors.filter((e) =>
      e.message.includes("Unknown identifier"),
    );
    expect(unknownIdErrors).toEqual([]);
  });

  it("module-level var inside try/catch hoisted as module global", async () => {
    const result = compileOnly(`
      try {
        var z: number = 99;
      } catch (e) {
        var w: number = 0;
      }
      export function test(): number {
        return z;
      }
    `);
    const unknownIdErrors = result.errors.filter((e) =>
      e.message.includes("Unknown identifier"),
    );
    expect(unknownIdErrors).toEqual([]);
  });

  it("module-level var inside while loop hoisted as module global", async () => {
    const result = compileOnly(`
      var count: number = 0;
      while (count < 1) {
        var inside: number = 10;
        count = count + 1;
      }
      export function test(): number {
        return inside;
      }
    `);
    const unknownIdErrors = result.errors.filter((e) =>
      e.message.includes("Unknown identifier"),
    );
    expect(unknownIdErrors).toEqual([]);
  });

  it("module-level var inside switch hoisted as module global", async () => {
    const result = compileOnly(`
      var val: number = 1;
      switch (val) {
        case 1:
          var switchResult: number = 10;
          break;
      }
      export function test(): number {
        return switchResult;
      }
    `);
    const unknownIdErrors = result.errors.filter((e) =>
      e.message.includes("Unknown identifier"),
    );
    expect(unknownIdErrors).toEqual([]);
  });

  it("module-level top-level statements compiled into init", async () => {
    const result = compileOnly(`
      var iterCount: number = 0;
      for (var i: number = 0; i < 3; i++) {
        iterCount = iterCount + 1;
      }
      export function test(): number {
        return iterCount;
      }
    `);
    const unknownIdErrors = result.errors.filter((e) =>
      e.message.includes("Unknown identifier"),
    );
    expect(unknownIdErrors).toEqual([]);
  });
});

describe("issue-146: module-level var hoisting runtime tests", () => {
  it("module-level var in for loop executes and is accessible", async () => {
    const e = await compileAndRun(`
      for (var i: number = 0; i < 5; i++) {
      }
      export function test(): number {
        return i;
      }
    `);
    expect(e.test()).toBe(5);
  });

  it("module-level var in if block executes and is accessible", async () => {
    const e = await compileAndRun(`
      var cond: number = 1;
      if (cond) {
        var y: number = 42;
      }
      export function test(): number {
        return y;
      }
    `);
    expect(e.test()).toBe(42);
  });

  it("module-level var in while loop executes and is accessible", async () => {
    const e = await compileAndRun(`
      var counter: number = 0;
      while (counter < 3) {
        var whileResult: number = counter;
        counter = counter + 1;
      }
      export function test(): number {
        return whileResult;
      }
    `);
    expect(e.test()).toBe(2);
  });
});
