import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

async function runFast(source: string, exportName = "test"): Promise<any> {
  const result = compile(source, { fast: true });
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await instantiateWasm(result.binary, imports.env);
  if (imports.setExports) {
    imports.setExports(instance.exports as Record<string, Function>);
  }
  return (instance.exports[exportName] as Function)();
}

describe("fast mode: native arrays", () => {
  describe("array literal and length", () => {
    it("empty array has length 0", async () => {
      const src = `
        export function test(): number {
          const arr: number[] = [];
          return arr.length;
        }
      `;
      expect(await runFast(src)).toBe(0);
    });

    it("array literal length", async () => {
      const src = `
        export function test(): number {
          const arr = [10, 20, 30];
          return arr.length;
        }
      `;
      expect(await runFast(src)).toBe(3);
    });

    it("length returns i32 (no f64 conversion in WAT)", () => {
      const result = compile(
        `export function test(): number {
          const arr = [1, 2, 3];
          return arr.length;
        }`,
        { fast: true },
      );
      expect(result.success).toBe(true);
      // In fast mode, length should not convert to f64
      expect(result.wat).not.toContain("f64.convert_i32_s");
    });
  });

  describe("element access (read)", () => {
    it("read first element", async () => {
      const src = `
        export function test(): number {
          const arr = [10, 20, 30];
          return arr[0];
        }
      `;
      expect(await runFast(src)).toBe(10);
    });

    it("read middle element", async () => {
      const src = `
        export function test(): number {
          const arr = [10, 20, 30];
          return arr[1];
        }
      `;
      expect(await runFast(src)).toBe(20);
    });

    it("read last element", async () => {
      const src = `
        export function test(): number {
          const arr = [10, 20, 30];
          return arr[2];
        }
      `;
      expect(await runFast(src)).toBe(30);
    });

    it("read with variable index", async () => {
      const src = `
        export function test(): number {
          const arr = [10, 20, 30];
          const i = 2;
          return arr[i];
        }
      `;
      expect(await runFast(src)).toBe(30);
    });
  });

  describe("element access (write)", () => {
    it("write and read back", async () => {
      const src = `
        export function test(): number {
          const arr = [10, 20, 30];
          arr[1] = 99;
          return arr[1];
        }
      `;
      expect(await runFast(src)).toBe(99);
    });

    it("write does not affect other elements", async () => {
      const src = `
        export function test(): number {
          const arr = [10, 20, 30];
          arr[1] = 99;
          return arr[0] + arr[2];
        }
      `;
      expect(await runFast(src)).toBe(40);
    });
  });

  describe("push", () => {
    it("push increases length", async () => {
      const src = `
        export function test(): number {
          const arr: number[] = [];
          arr.push(42);
          return arr.length;
        }
      `;
      expect(await runFast(src)).toBe(1);
    });

    it("push returns new length as i32", async () => {
      const src = `
        export function test(): number {
          const arr = [1, 2, 3];
          return arr.push(4);
        }
      `;
      expect(await runFast(src)).toBe(4);
    });

    it("push element is accessible", async () => {
      const src = `
        export function test(): number {
          const arr: number[] = [];
          arr.push(42);
          return arr[0];
        }
      `;
      expect(await runFast(src)).toBe(42);
    });

    it("push multiple elements sequentially", async () => {
      const src = `
        export function test(): number {
          const arr: number[] = [];
          arr.push(10);
          arr.push(20);
          arr.push(30);
          return arr[0] + arr[1] + arr[2];
        }
      `;
      expect(await runFast(src)).toBe(60);
    });

    it("push triggers capacity growth", async () => {
      const src = `
        export function test(): number {
          const arr: number[] = [];
          for (let i = 0; i < 20; i++) {
            arr.push(i);
          }
          return arr.length;
        }
      `;
      expect(await runFast(src)).toBe(20);
    });

    it("push preserves elements after growth", async () => {
      const src = `
        export function test(): number {
          const arr: number[] = [];
          for (let i = 0; i < 10; i++) {
            arr.push(i * 10);
          }
          return arr[0] + arr[5] + arr[9];
        }
      `;
      // 0 + 50 + 90 = 140
      expect(await runFast(src)).toBe(140);
    });
  });

  describe("pop", () => {
    it("pop returns last element", async () => {
      const src = `
        export function test(): number {
          const arr = [10, 20, 30];
          return arr.pop();
        }
      `;
      expect(await runFast(src)).toBe(30);
    });

    it("pop decreases length", async () => {
      const src = `
        export function test(): number {
          const arr = [10, 20, 30];
          arr.pop();
          return arr.length;
        }
      `;
      expect(await runFast(src)).toBe(2);
    });
  });

  describe("indexOf", () => {
    it("finds element at beginning", async () => {
      const src = `
        export function test(): number {
          const arr = [10, 20, 30];
          return arr.indexOf(10);
        }
      `;
      expect(await runFast(src)).toBe(0);
    });

    it("finds element in middle", async () => {
      const src = `
        export function test(): number {
          const arr = [10, 20, 30];
          return arr.indexOf(20);
        }
      `;
      expect(await runFast(src)).toBe(1);
    });

    it("returns -1 for missing element", async () => {
      const src = `
        export function test(): number {
          const arr = [10, 20, 30];
          return arr.indexOf(99);
        }
      `;
      expect(await runFast(src)).toBe(-1);
    });

    it("indexOf returns i32 in fast mode (no f64 conversion)", () => {
      const result = compile(
        `export function test(): number {
          const arr = [1, 2, 3];
          return arr.indexOf(2);
        }`,
        { fast: true },
      );
      expect(result.success).toBe(true);
      // In fast mode indexOf should not have f64.const -1
      expect(result.wat).not.toContain("f64.const -1");
    });
  });

  describe("includes", () => {
    it("returns 1 when element exists", async () => {
      const src = `
        export function test(): boolean {
          const arr = [10, 20, 30];
          return arr.includes(20);
        }
      `;
      expect(await runFast(src)).toBe(1);
    });

    it("returns 0 when element missing", async () => {
      const src = `
        export function test(): boolean {
          const arr = [10, 20, 30];
          return arr.includes(99);
        }
      `;
      expect(await runFast(src)).toBe(0);
    });
  });

  describe("slice", () => {
    it("slice(1) returns subarray from index 1", async () => {
      const src = `
        export function test(): number {
          const arr = [10, 20, 30, 40];
          const s = arr.slice(1);
          return s.length;
        }
      `;
      expect(await runFast(src)).toBe(3);
    });

    it("slice(1, 3) returns elements [1..3)", async () => {
      const src = `
        export function test(): number {
          const arr = [10, 20, 30, 40];
          const s = arr.slice(1, 3);
          return s[0] + s[1];
        }
      `;
      // 20 + 30
      expect(await runFast(src)).toBe(50);
    });
  });

  describe("concat", () => {
    it("concatenates two arrays", async () => {
      const src = `
        export function test(): number {
          const a = [1, 2, 3];
          const b = [4, 5, 6];
          const c = a.concat(b);
          return c.length;
        }
      `;
      expect(await runFast(src)).toBe(6);
    });

    it("elements are correct after concat", async () => {
      const src = `
        export function test(): number {
          const a = [10, 20];
          const b = [30, 40];
          const c = a.concat(b);
          return c[0] + c[1] + c[2] + c[3];
        }
      `;
      expect(await runFast(src)).toBe(100);
    });
  });

  describe("reverse", () => {
    it("reverses array in place", async () => {
      const src = `
        export function test(): number {
          const arr = [1, 2, 3];
          arr.reverse();
          return arr[0] * 100 + arr[1] * 10 + arr[2];
        }
      `;
      // 3*100 + 2*10 + 1 = 321
      expect(await runFast(src)).toBe(321);
    });
  });

  describe("combined operations", () => {
    it("loop with push and index", async () => {
      const src = `
        export function test(): number {
          const arr: number[] = [];
          for (let i = 0; i < 5; i++) {
            arr.push(i * i);
          }
          let sum = 0;
          for (let i = 0; i < arr.length; i++) {
            sum = sum + arr[i];
          }
          return sum;
        }
      `;
      // 0 + 1 + 4 + 9 + 16 = 30
      expect(await runFast(src)).toBe(30);
    });

    it("push, pop, indexOf together", async () => {
      const src = `
        export function test(): number {
          const arr: number[] = [];
          arr.push(100);
          arr.push(200);
          arr.push(300);
          arr.pop();
          return arr.indexOf(200);
        }
      `;
      expect(await runFast(src)).toBe(1);
    });

    it("array as function parameter", async () => {
      const src = `
        function sum(arr: number[]): number {
          let s = 0;
          for (let i = 0; i < arr.length; i++) {
            s = s + arr[i];
          }
          return s;
        }
        export function test(): number {
          return sum([10, 20, 30]);
        }
      `;
      expect(await runFast(src)).toBe(60);
    });

    it("array returned from function", async () => {
      const src = `
        function makeArr(): number[] {
          const a: number[] = [];
          a.push(5);
          a.push(10);
          a.push(15);
          return a;
        }
        export function test(): number {
          const arr = makeArr();
          return arr[0] + arr[1] + arr[2];
        }
      `;
      expect(await runFast(src)).toBe(30);
    });
  });

  describe("fill", () => {
    it("fills entire array with value", async () => {
      const src = `
        export function test(): number {
          const arr = [1, 2, 3, 4, 5];
          arr.fill(0);
          return arr[0] + arr[1] + arr[2] + arr[3] + arr[4];
        }
      `;
      expect(await runFast(src)).toBe(0);
    });

    it("fills with start index", async () => {
      const src = `
        export function test(): number {
          const arr = [1, 2, 3, 4, 5];
          arr.fill(9, 2);
          return arr[0] * 10000 + arr[1] * 1000 + arr[2] * 100 + arr[3] * 10 + arr[4];
        }
      `;
      // 1*10000 + 2*1000 + 9*100 + 9*10 + 9 = 12999
      expect(await runFast(src)).toBe(12999);
    });

    it("fills with start and end", async () => {
      const src = `
        export function test(): number {
          const arr = [1, 2, 3, 4, 5];
          arr.fill(7, 1, 3);
          return arr[0] * 10000 + arr[1] * 1000 + arr[2] * 100 + arr[3] * 10 + arr[4];
        }
      `;
      // 1*10000 + 7*1000 + 7*100 + 4*10 + 5 = 17745
      expect(await runFast(src)).toBe(17745);
    });

    it("fill mutates original array", async () => {
      const src = `
        export function test(): number {
          const arr = [1, 2, 3];
          arr.fill(5);
          return arr[0] + arr[1] + arr[2];
        }
      `;
      expect(await runFast(src)).toBe(15);
    });

    it("fill preserves length", async () => {
      const src = `
        export function test(): number {
          const arr = [1, 2, 3, 4];
          arr.fill(0);
          return arr.length;
        }
      `;
      expect(await runFast(src)).toBe(4);
    });
  });

  describe("copyWithin", () => {
    it("copies elements within array", async () => {
      const src = `
        export function test(): number {
          const arr = [1, 2, 3, 4, 5];
          arr.copyWithin(0, 3);
          return arr[0] * 10000 + arr[1] * 1000 + arr[2] * 100 + arr[3] * 10 + arr[4];
        }
      `;
      // copies [4,5] to position 0: [4, 5, 3, 4, 5]
      expect(await runFast(src)).toBe(45345);
    });

    it("copies with end parameter", async () => {
      const src = `
        export function test(): number {
          const arr = [1, 2, 3, 4, 5];
          arr.copyWithin(1, 3, 4);
          return arr[0] * 10000 + arr[1] * 1000 + arr[2] * 100 + arr[3] * 10 + arr[4];
        }
      `;
      // copies [4] to position 1: [1, 4, 3, 4, 5]
      expect(await runFast(src)).toBe(14345);
    });

    it("copyWithin mutates original array", async () => {
      const src = `
        export function test(): number {
          const arr = [10, 20, 30];
          arr.copyWithin(0, 1);
          return arr[0] + arr[1] + arr[2];
        }
      `;
      // copies [20, 30] to position 0: [20, 30, 30]
      expect(await runFast(src)).toBe(80);
    });

    it("preserves length", async () => {
      const src = `
        export function test(): number {
          const arr = [1, 2, 3, 4, 5];
          arr.copyWithin(0, 2);
          return arr.length;
        }
      `;
      expect(await runFast(src)).toBe(5);
    });
  });

  describe("lastIndexOf", () => {
    it("finds last occurrence", async () => {
      const src = `
        export function test(): number {
          const arr = [1, 2, 3, 2, 1];
          return arr.lastIndexOf(2);
        }
      `;
      expect(await runFast(src)).toBe(3);
    });

    it("returns -1 for missing element", async () => {
      const src = `
        export function test(): number {
          const arr = [1, 2, 3];
          return arr.lastIndexOf(99);
        }
      `;
      expect(await runFast(src)).toBe(-1);
    });

    it("finds element at end", async () => {
      const src = `
        export function test(): number {
          const arr = [10, 20, 30];
          return arr.lastIndexOf(30);
        }
      `;
      expect(await runFast(src)).toBe(2);
    });

    it("finds element at beginning", async () => {
      const src = `
        export function test(): number {
          const arr = [10, 20, 30];
          return arr.lastIndexOf(10);
        }
      `;
      expect(await runFast(src)).toBe(0);
    });

    it("with fromIndex parameter", async () => {
      const src = `
        export function test(): number {
          const arr = [1, 2, 3, 2, 1];
          return arr.lastIndexOf(2, 2);
        }
      `;
      // Searching backwards from index 2: finds 2 at index 1
      expect(await runFast(src)).toBe(1);
    });

    it("returns i32 in fast mode (no f64 conversion)", () => {
      const result = compile(
        `export function test(): number {
          const arr = [1, 2, 3];
          return arr.lastIndexOf(2);
        }`,
        { fast: true },
      );
      expect(result.success).toBe(true);
      expect(result.wat).not.toContain("f64.const -1");
    });
  });

  describe("sort (fast mode i32)", () => {
    it("sorts array in ascending order", async () => {
      const src = `
        export function test(): number {
          const arr = [3, 1, 4, 1, 5, 9, 2, 6];
          arr.sort();
          return arr[0] * 10000000 + arr[1] * 1000000 + arr[2] * 100000 + arr[3] * 10000 + arr[4] * 1000 + arr[5] * 100 + arr[6] * 10 + arr[7];
        }
      `;
      // sorted: [1,1,2,3,4,5,6,9] -> 11234569
      expect(await runFast(src)).toBe(11234569);
    });

    it("sort preserves length", async () => {
      const src = `
        export function test(): number {
          const arr = [5, 3, 1];
          arr.sort();
          return arr.length;
        }
      `;
      expect(await runFast(src)).toBe(3);
    });

    it("sort already sorted array", async () => {
      const src = `
        export function test(): number {
          const arr = [1, 2, 3];
          arr.sort();
          return arr[0] * 100 + arr[1] * 10 + arr[2];
        }
      `;
      expect(await runFast(src)).toBe(123);
    });

    it("sort single element", async () => {
      const src = `
        export function test(): number {
          const arr = [42];
          arr.sort();
          return arr[0];
        }
      `;
      expect(await runFast(src)).toBe(42);
    });

    it("sort with negative numbers", async () => {
      const src = `
        export function test(): number {
          const arr = [3, -1, 2, -5];
          arr.sort();
          return arr[0];
        }
      `;
      expect(await runFast(src)).toBe(-5);
    });

    it("sort empty array", async () => {
      const src = `
        export function test(): number {
          const arr: number[] = [];
          arr.sort();
          return arr.length;
        }
      `;
      expect(await runFast(src)).toBe(0);
    });

    it("sort two elements", async () => {
      const src = `
        export function test(): number {
          const arr = [9, 1];
          arr.sort();
          return arr[0] * 10 + arr[1];
        }
      `;
      expect(await runFast(src)).toBe(19);
    });

    it("sort reverse-sorted array", async () => {
      const src = `
        export function test(): number {
          const arr = [5, 4, 3, 2, 1];
          arr.sort();
          return arr[0] * 10000 + arr[1] * 1000 + arr[2] * 100 + arr[3] * 10 + arr[4];
        }
      `;
      expect(await runFast(src)).toBe(12345);
    });

    it("sort array with all duplicates", async () => {
      const src = `
        export function test(): number {
          const arr = [7, 7, 7, 7];
          arr.sort();
          return arr[0] + arr[1] + arr[2] + arr[3];
        }
      `;
      expect(await runFast(src)).toBe(28);
    });

    it("sort is stable (preserves order of equal elements via structure)", async () => {
      const src = `
        export function test(): number {
          const arr = [3, 1, 2, 1, 3, 2];
          arr.sort();
          return arr[0] * 100000 + arr[1] * 10000 + arr[2] * 1000 + arr[3] * 100 + arr[4] * 10 + arr[5];
        }
      `;
      expect(await runFast(src)).toBe(112233);
    });

    it("sort returns the array (chainable)", async () => {
      const src = `
        export function test(): number {
          const arr = [3, 1, 2];
          const sorted = arr.sort();
          return sorted[0] * 100 + sorted[1] * 10 + sorted[2];
        }
      `;
      expect(await runFast(src)).toBe(123);
    });

    it("sort large array (>64 elements, exercises full Timsort)", async () => {
      const src = `
        export function test(): number {
          const arr: number[] = [];
          let i = 100;
          while (i > 0) {
            arr.push(i);
            i = i - 1;
          }
          arr.sort();
          // Check: first=1, last=100, and arr[49]=50
          return arr[0] * 10000 + arr[49] * 100 + arr[99];
        }
      `;
      // 1 * 10000 + 50 * 100 + 100 = 10000 + 5000 + 100 = 15100
      expect(await runFast(src)).toBe(15100);
    });
  });

  describe("filter (fast mode i32)", () => {
    it("filter keeps matching elements", async () => {
      const src = `
        export function test(): number {
          const arr = [10, 20, 5, 30, 3];
          const big = arr.filter(x => x > 9);
          return big.length;
        }
      `;
      expect(await runFast(src)).toBe(3);
    });

    it("filter returns empty for no matches", async () => {
      const src = `
        export function test(): number {
          const arr = [1, 2, 3];
          const none = arr.filter(x => x > 100);
          return none.length;
        }
      `;
      expect(await runFast(src)).toBe(0);
    });
  });

  describe("map (fast mode i32)", () => {
    it("maps elements with callback", async () => {
      const src = `
        export function test(): number {
          const arr = [1, 2, 3];
          const doubled = arr.map(x => x * 2);
          return doubled[0] + doubled[1] + doubled[2];
        }
      `;
      expect(await runFast(src)).toBe(12);
    });
  });

  describe("reduce (fast mode i32)", () => {
    it("reduces to sum", async () => {
      const src = `
        export function test(): number {
          const arr = [1, 2, 3, 4];
          return arr.reduce((acc, x) => acc + x, 0);
        }
      `;
      expect(await runFast(src)).toBe(10);
    });
  });

  describe("forEach (fast mode i32)", () => {
    it("forEach compiles and runs without error", async () => {
      const src = `
        export function test(): number {
          const arr = [10, 20, 30];
          arr.forEach(x => x + 1);
          return arr.length;
        }
      `;
      expect(await runFast(src)).toBe(3);
    });
  });

  describe("find (fast mode i32)", () => {
    it("finds first matching element", async () => {
      const src = `
        export function test(): number {
          const arr = [1, 5, 10, 15];
          return arr.find(x => x > 7);
        }
      `;
      expect(await runFast(src)).toBe(10);
    });

    it("returns 0 when not found", async () => {
      const src = `
        export function test(): number {
          const arr = [1, 2, 3];
          return arr.find(x => x > 100);
        }
      `;
      expect(await runFast(src)).toBe(0);
    });
  });

  describe("findIndex (fast mode i32)", () => {
    it("finds index of first match", async () => {
      const src = `
        export function test(): number {
          const arr = [1, 5, 10, 15];
          return arr.findIndex(x => x > 7);
        }
      `;
      expect(await runFast(src)).toBe(2);
    });

    it("returns -1 when not found", async () => {
      const src = `
        export function test(): number {
          const arr = [1, 2, 3];
          return arr.findIndex(x => x > 100);
        }
      `;
      expect(await runFast(src)).toBe(-1);
    });
  });

  describe("some (fast mode i32)", () => {
    it("returns 1 when some match", async () => {
      const src = `
        export function test(): number {
          const arr = [1, 2, 3];
          return arr.some(x => x > 2) ? 1 : 0;
        }
      `;
      expect(await runFast(src)).toBe(1);
    });

    it("returns 0 when none match", async () => {
      const src = `
        export function test(): number {
          const arr = [1, 2, 3];
          return arr.some(x => x > 10) ? 1 : 0;
        }
      `;
      expect(await runFast(src)).toBe(0);
    });
  });

  describe("every (fast mode i32)", () => {
    it("returns 1 when all match", async () => {
      const src = `
        export function test(): number {
          const arr = [2, 4, 6];
          return arr.every(x => x > 1) ? 1 : 0;
        }
      `;
      expect(await runFast(src)).toBe(1);
    });

    it("returns 0 when one fails", async () => {
      const src = `
        export function test(): number {
          const arr = [2, 4, 1];
          return arr.every(x => x > 1) ? 1 : 0;
        }
      `;
      expect(await runFast(src)).toBe(0);
    });
  });

  describe("spread in array literal", () => {
    it("spread copies elements", async () => {
      const src = `
        export function test(): number {
          const a = [1, 2, 3];
          const b = [...a, 4, 5];
          return b.length;
        }
      `;
      expect(await runFast(src)).toBe(5);
    });

    it("spread preserves values", async () => {
      const src = `
        export function test(): number {
          const a = [10, 20];
          const b = [...a, 30];
          return b[0] + b[1] + b[2];
        }
      `;
      expect(await runFast(src)).toBe(60);
    });
  });
});
