import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function run(source: string, fn: string, args: unknown[]): Promise<unknown> {
  const result = compile(source);
  if (!result.success) throw new Error(result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n"));
  const { instance } = await WebAssembly.instantiate(result.binary, {
    env: {
      console_log_number: () => {},
      console_log_bool: () => {},
    },
  });
  return (instance.exports as any)[fn](...args);
}

describe("labeled break", () => {
  it("break outer from nested for loops", async () => {
    const src = `
      export function test(): number {
        let result: number = 0;
        outer: for (let i: number = 0; i < 3; i = i + 1) {
          for (let j: number = 0; j < 3; j = j + 1) {
            if (i === 1 && j === 1) break outer;
            result = result + 1;
          }
        }
        return result;
      }
    `;
    // i=0: j=0,1,2 -> 3 iterations
    // i=1: j=0 -> 1 iteration, then j=1 breaks outer
    expect(await run(src, "test", [])).toBe(4);
  });

  it("break outer from nested while loops", async () => {
    const src = `
      export function test(): number {
        let result: number = 0;
        let i: number = 0;
        outer: while (i < 5) {
          let j: number = 0;
          while (j < 5) {
            if (j === 2) break outer;
            result = result + 1;
            j = j + 1;
          }
          i = i + 1;
        }
        return result;
      }
    `;
    // i=0: j=0,1 -> 2 iterations, then j=2 breaks outer
    expect(await run(src, "test", [])).toBe(2);
  });

  it("unlabeled break still works inside labeled loop", async () => {
    const src = `
      export function test(): number {
        let result: number = 0;
        outer: for (let i: number = 0; i < 3; i = i + 1) {
          for (let j: number = 0; j < 10; j = j + 1) {
            if (j === 2) break;
            result = result + 1;
          }
        }
        return result;
      }
    `;
    // Each outer iteration: inner runs j=0,1 (2 iterations), then j=2 breaks inner only
    // 3 outer iterations * 2 = 6
    expect(await run(src, "test", [])).toBe(6);
  });
});

describe("labeled continue", () => {
  it("continue outer from nested for loops", async () => {
    const src = `
      export function test(): number {
        let result: number = 0;
        outer: for (let i: number = 0; i < 3; i = i + 1) {
          for (let j: number = 0; j < 3; j = j + 1) {
            if (j === 1) continue outer;
            result = result + 1;
          }
        }
        return result;
      }
    `;
    // Each outer iteration: j=0 increments, j=1 continues outer -> 1 per outer
    // 3 outer iterations * 1 = 3
    expect(await run(src, "test", [])).toBe(3);
  });

  it("continue outer from nested while loops", async () => {
    const src = `
      export function test(): number {
        let count: number = 0;
        let i: number = 0;
        outer: while (i < 3) {
          i = i + 1;
          let j: number = 0;
          while (j < 3) {
            j = j + 1;
            if (j === 2) continue outer;
            count = count + 1;
          }
          count = count + 100;
        }
        return count;
      }
    `;
    // Each outer iteration: j increments to 1 (count+1), then j=2 continues outer
    // 3 outer iterations, each adds 1 (never reaches count+100)
    expect(await run(src, "test", [])).toBe(3);
  });
});

describe("multiple nesting levels", () => {
  it("three levels of nested loops with labeled break", async () => {
    const src = `
      export function test(): number {
        let result: number = 0;
        outer: for (let i: number = 0; i < 5; i = i + 1) {
          for (let j: number = 0; j < 5; j = j + 1) {
            for (let k: number = 0; k < 5; k = k + 1) {
              if (k === 1) break outer;
              result = result + 1;
            }
          }
        }
        return result;
      }
    `;
    // i=0, j=0, k=0: result=1, then k=1 breaks outer
    expect(await run(src, "test", [])).toBe(1);
  });

  it("middle label break from three levels", async () => {
    const src = `
      export function test(): number {
        let result: number = 0;
        for (let i: number = 0; i < 2; i = i + 1) {
          middle: for (let j: number = 0; j < 5; j = j + 1) {
            for (let k: number = 0; k < 5; k = k + 1) {
              if (k === 1) break middle;
              result = result + 1;
            }
          }
        }
        return result;
      }
    `;
    // Each outer iteration: j=0, k=0 (result+1), k=1 breaks middle, so j loop exits
    // 2 outer iterations * 1 = 2
    expect(await run(src, "test", [])).toBe(2);
  });
});
