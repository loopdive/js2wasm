import { describe, it, expect } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

describe("Issue #855: Promise resolution and async error handling", () => {
  it("Promise.resolve returns externref, instanceof works", async () => {
    const src = `
      export function test(): number {
        const p = Promise.resolve(42);
        if (p instanceof Promise) return 1;
        return 0;
      }
    `;
    const wasm = await compileToWasm(src);
    expect(wasm.test()).toBe(1);
  });

  it("Promise.all([]) returns externref Promise", async () => {
    const src = `
      export function test(): number {
        const p = Promise.all([]);
        if (p instanceof Promise) return 1;
        return 0;
      }
    `;
    const wasm = await compileToWasm(src);
    expect(wasm.test()).toBe(1);
  });

  it("typeof Promise.all === 'function'", async () => {
    const src = `
      export function test(): number {
        if (typeof Promise.all === "function") return 1;
        return 0;
      }
    `;
    const wasm = await compileToWasm(src);
    expect(wasm.test()).toBe(1);
  });

  it("new Promise(executor) works", async () => {
    const src = `
      export function test(): number {
        const p = new Promise(function(resolve: any, reject: any): void {
          resolve(42);
        });
        if (p instanceof Promise) return 1;
        return 0;
      }
    `;
    const wasm = await compileToWasm(src);
    expect(wasm.test()).toBe(1);
  });

  it("async function still returns unwrapped value", async () => {
    const src = `
      async function getValue(): Promise<number> { return 42; }
      export function main(): number {
        return getValue() as any as number;
      }
    `;
    const wasm = await compileToWasm(src);
    expect(wasm.main()).toBe(42);
  });

  it("Promise.resolve().then() callback fires via microtask", async () => {
    const src = `
      let result: number = 0;
      export function test(): number {
        const p = Promise.resolve(42);
        p.then(function(v: any): void {
          result = 1;
        });
        return result;
      }
      export function getResult(): number {
        return result;
      }
    `;
    const wasm = await compileToWasm(src);
    // Sync: callback hasn't fired yet
    expect(wasm.test()).toBe(0);
    // Wait for microtask
    await new Promise((r) => setTimeout(r, 50));
    // Async: callback should have fired
    expect(wasm.getResult()).toBe(1);
  });
});
