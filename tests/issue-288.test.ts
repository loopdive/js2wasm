import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "./equivalence/helpers.js";

async function run(source: string, fn: string, args: unknown[]): Promise<unknown> {
  const result = compile(source);
  if (!result.success) throw new Error(`Compile failed:\n${result.errors.map(e => `L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`);
  const imports = buildImports(result);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
  return (instance.exports as any)[fn](...args);
}

function compileOnly(source: string) {
  const result = compile(source);
  if (!result.success) throw new Error(`Compile failed:\n${result.errors.map(e => `L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`);
  return result;
}

describe("Issue #288: Try/catch/finally complex patterns", () => {

  describe("catch without binding", () => {
    it("catch with no variable", async () => {
      const src = `
        export function test(): number {
          try {
            throw "error";
          } catch {
            return 42;
          }
          return 0;
        }
      `;
      expect(await run(src, "test", [])).toBe(42);
    });

    it("catch with no variable - normal path", async () => {
      const src = `
        export function test(): number {
          let x = 0;
          try {
            x = 10;
          } catch {
            x = -1;
          }
          return x;
        }
      `;
      expect(await run(src, "test", [])).toBe(10);
    });
  });

  describe("try-only-finally (no catch)", () => {
    it("try/finally without catch - normal path", async () => {
      const src = `
        export function test(): number {
          let x = 0;
          try {
            x = 10;
          } finally {
            x = x + 1;
          }
          return x;
        }
      `;
      expect(await run(src, "test", [])).toBe(11);
    });

    it("try/finally without catch - exception runs finally then propagates", async () => {
      const src = `
        export function test(): number {
          let x = 0;
          try {
            try {
              x = 5;
              throw "err";
            } finally {
              x = x + 100;
            }
          } catch (e) {
            // x should be 105 here (5 + 100 from finally)
            x = x + 1000;
          }
          return x;
        }
      `;
      // try body: x=5, throw, finally: x=105, outer catch: x=1105
      expect(await run(src, "test", [])).toBe(1105);
    });
  });

  describe("nested try/catch", () => {
    it("nested try inside try", async () => {
      const src = `
        export function test(): number {
          let result = 0;
          try {
            try {
              result = 1;
            } catch (e) {
              result = 2;
            }
            result = result + 10;
          } catch (e) {
            result = -1;
          }
          return result;
        }
      `;
      expect(await run(src, "test", [])).toBe(11);
    });

    it("nested try inside catch", async () => {
      const src = `
        export function test(): number {
          let result = 0;
          try {
            throw "outer";
          } catch (e) {
            try {
              result = 5;
            } catch (e2) {
              result = -1;
            }
          }
          return result;
        }
      `;
      expect(await run(src, "test", [])).toBe(5);
    });

    it("nested try inside finally", async () => {
      const src = `
        export function test(): number {
          let result = 0;
          try {
            result = 1;
          } finally {
            try {
              result = result + 10;
            } catch (e) {
              result = -1;
            }
          }
          return result;
        }
      `;
      expect(await run(src, "test", [])).toBe(11);
    });
  });

  describe("try in loops", () => {
    it("try/catch inside for loop", async () => {
      const src = `
        export function test(): number {
          let sum = 0;
          for (let i = 0; i < 3; i++) {
            try {
              sum = sum + i;
            } catch (e) {
              sum = -1;
            }
          }
          return sum;
        }
      `;
      expect(await run(src, "test", [])).toBe(3);
    });

    it("try/catch with break inside loop", async () => {
      const src = `
        export function test(): number {
          let result = 0;
          for (let i = 0; i < 10; i++) {
            try {
              if (i === 3) break;
              result = result + 1;
            } catch (e) {
              result = -1;
            }
          }
          return result;
        }
      `;
      expect(await run(src, "test", [])).toBe(3);
    });

    it("try/catch with continue inside loop", async () => {
      const src = `
        export function test(): number {
          let sum = 0;
          for (let i = 0; i < 5; i++) {
            try {
              if (i === 2) continue;
              sum = sum + i;
            } catch (e) {
              sum = -1;
            }
          }
          return sum;
        }
      `;
      // 0 + 1 + 3 + 4 = 8 (skipping i=2)
      expect(await run(src, "test", [])).toBe(8);
    });

    it("try/catch inside while loop", async () => {
      const src = `
        export function test(): number {
          let sum = 0;
          let i = 0;
          while (i < 3) {
            try {
              sum = sum + i;
            } catch (e) {
              sum = -1;
            }
            i = i + 1;
          }
          return sum;
        }
      `;
      expect(await run(src, "test", [])).toBe(3);
    });
  });

  describe("finally with return", () => {
    it("finally block executes on normal return", async () => {
      const src = `
        export function test(): number {
          let x = 0;
          try {
            x = 5;
          } catch (e) {
            x = -1;
          } finally {
            x = x + 100;
          }
          return x;
        }
      `;
      expect(await run(src, "test", [])).toBe(105);
    });

    it("finally block executes on exception path", async () => {
      const src = `
        export function test(): number {
          let x = 0;
          try {
            throw "err";
          } catch (e) {
            x = 10;
          } finally {
            x = x + 100;
          }
          return x;
        }
      `;
      expect(await run(src, "test", [])).toBe(110);
    });
  });

  describe("complex catch patterns", () => {
    it("multiple nested try/catch/finally", async () => {
      const src = `
        export function test(): number {
          let result = 0;
          try {
            try {
              throw "inner";
            } catch (e) {
              result = 1;
            } finally {
              result = result + 10;
            }
          } catch (e) {
            result = -100;
          } finally {
            result = result + 100;
          }
          return result;
        }
      `;
      // inner throw caught by inner catch: result=1
      // inner finally: result=11
      // outer finally: result=111
      expect(await run(src, "test", [])).toBe(111);
    });

    it("catch rethrow with finally", async () => {
      const src = `
        export function test(): number {
          let result = 0;
          try {
            try {
              throw "first";
            } catch (e) {
              result = 10;
              throw "second";
            } finally {
              result = result + 1;
            }
          } catch (e) {
            result = result + 100;
          }
          return result;
        }
      `;
      // inner throw caught: result=10, then rethrow
      // inner finally: result=11
      // outer catch: result=111
      expect(await run(src, "test", [])).toBe(111);
    });
  });
});
