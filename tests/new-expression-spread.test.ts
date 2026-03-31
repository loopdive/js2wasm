import { describe, it, expect } from "vitest";
import {
  compileToWasm,
  evaluateAsJs,
  assertEquivalent,
  buildImports,
  compile,
  readFileSync,
  resolve,
} from "./helpers.js";

describe("New expression with spread arguments (#213)", () => {
  it("spread-sngl-empty: new function(){}(...[])", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        var callCount = 0;
        new function() {
          callCount = callCount + 1;
        }(...[]);
        return callCount;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("spread-sngl-literal: new function(){}(...[3,4,5]) with arguments", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        var result = 0;
        new function() {
          result = arguments.length;
        }(...[3, 4, 5]);
        return result;
      }
    `);
    expect(exports.test()).toBe(3);
  });

  it("spread-sngl-literal: typed params receive spread values", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        var result = 0;
        new function(a: number, b: number, c: number) {
          result = a + b + c;
        }(...[3, 4, 5]);
        return result;
      }
    `);
    expect(exports.test()).toBe(12);
  });

  it("spread-mult-empty: new function(){}(1, 2, 3, ...[])", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        var result = 0;
        new function() {
          result = arguments.length;
        }(1, 2, 3, ...[]);
        return result;
      }
    `);
    expect(exports.test()).toBe(3);
  });

  it("spread-mult-literal: new function(){}(5, ...[6, 7, 8], 9)", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        var result = 0;
        new function() {
          result = arguments.length;
        }(5, ...[6, 7, 8], 9);
        return result;
      }
    `);
    expect(exports.test()).toBe(5);
  });

  it("spread-mult-literal: typed params receive correct values", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        var result = 0;
        new function(a: number, b: number, c: number, d: number, e: number) {
          result = a + b + c + d + e;
        }(5, ...[6, 7, 8], 9);
        return result;
      }
    `);
    expect(exports.test()).toBe(35);
  });

  it("new expression at module top level with spread", async () => {
    const exports = await compileToWasm(`
      var callCount = 0;
      new function() {
        callCount = callCount + 1;
      }(...[]);
      export function test(): number {
        return callCount;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("module-level new with spread and typed params", async () => {
    const exports = await compileToWasm(`
      var result = 0;
      new function(a: number, b: number, c: number) {
        result = a + b + c;
      }(...[10, 20, 30]);
      export function test(): number {
        return result;
      }
    `);
    expect(exports.test()).toBe(60);
  });
});
