import { describe, it, expect, vi } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

/**
 * #937: console.info() and console.debug() as aliases for console.log()
 */
describe("console.info and console.debug (#937)", () => {
  it("console.info compiles and runs without error", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        console.info("info message");
        return 1;
      }
    `);
    expect(exports["test"]!()).toBe(1);
  });

  it("console.debug compiles and runs without error", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        console.debug("debug message");
        return 1;
      }
    `);
    expect(exports["test"]!()).toBe(1);
  });

  it("console.log, .warn, .error, .info, .debug all work together", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        console.log("log");
        console.warn("warn");
        console.error("error");
        console.info("info");
        console.debug("debug");
        return 5;
      }
    `);
    expect(exports["test"]!()).toBe(5);
  });

  it("console.info with number argument", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        console.info(42);
        return 42;
      }
    `);
    expect(exports["test"]!()).toBe(42);
  });
});
