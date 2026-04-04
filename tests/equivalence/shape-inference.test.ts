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

describe("Shape inference: array-like objects", () => {
  it("Array.prototype.indexOf.call on array-like object", async () => {
    const src = `
      var obj: any = {};
      obj.length = 3;
      obj[0] = 10;
      obj[1] = 20;
      obj[2] = 30;
      export function test(): number {
        return Array.prototype.indexOf.call(obj, 20);
      }
    `;
    const exports = await compileToWasm(src);
    expect(exports.test()).toBe(1);
  });

  it("Array.prototype.indexOf.call returns -1 for missing element", async () => {
    const src = `
      var obj: any = {};
      obj.length = 3;
      obj[0] = 10;
      obj[1] = 20;
      obj[2] = 30;
      export function test(): number {
        return Array.prototype.indexOf.call(obj, 99);
      }
    `;
    const exports = await compileToWasm(src);
    expect(exports.test()).toBe(-1);
  });

  it("Array.prototype.includes.call on array-like object", async () => {
    const src = `
      var obj: any = {};
      obj.length = 3;
      obj[0] = 10;
      obj[1] = 20;
      obj[2] = 30;
      export function testFound(): boolean {
        return Array.prototype.includes.call(obj, 20);
      }
      export function testMissing(): boolean {
        return Array.prototype.includes.call(obj, 99);
      }
    `;
    const exports = await compileToWasm(src);
    expect(exports.testFound()).toBe(1);
    expect(exports.testMissing()).toBe(0);
  });

  it("Array.prototype.indexOf.call with multiple elements", async () => {
    const src = `
      var obj: any = {};
      obj.length = 5;
      obj[0] = 1;
      obj[1] = 2;
      obj[2] = 3;
      obj[3] = 4;
      obj[4] = 5;
      export function findFirst(): number {
        return Array.prototype.indexOf.call(obj, 1);
      }
      export function findLast(): number {
        return Array.prototype.indexOf.call(obj, 5);
      }
      export function findMiddle(): number {
        return Array.prototype.indexOf.call(obj, 3);
      }
    `;
    const exports = await compileToWasm(src);
    expect(exports.findFirst()).toBe(0);
    expect(exports.findLast()).toBe(4);
    expect(exports.findMiddle()).toBe(2);
  });
});
