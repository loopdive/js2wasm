import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "./equivalence/helpers.js";

async function run(source: string, fn: string, args: unknown[] = []): Promise<unknown> {
  const result = compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
  const { instance } = await WebAssembly.instantiate(result.binary, buildImports(result));
  return (instance.exports as any)[fn](...args);
}

describe("Issue #665: Native Date implementation", () => {
  it("new Date(ms).getTime() returns the timestamp", async () => {
    const src = `
      export function test(): number {
        const d = new Date(1234567890000);
        return d.getTime();
      }
    `;
    expect(await run(src, "test")).toBe(1234567890000);
  });

  it("new Date(0).getTime() returns 0", async () => {
    const src = `
      export function test(): number {
        const d = new Date(0);
        return d.getTime();
      }
    `;
    expect(await run(src, "test")).toBe(0);
  });

  it("Date.now() returns a positive number", async () => {
    const src = `
      export function test(): number {
        return Date.now();
      }
    `;
    const result = await run(src, "test") as number;
    expect(result).toBeGreaterThan(0);
    // Should be a reasonable timestamp (after 2020)
    expect(result).toBeGreaterThan(1577836800000);
  });

  it("new Date().getTime() returns a positive number", async () => {
    const src = `
      export function test(): number {
        const d = new Date();
        return d.getTime();
      }
    `;
    const result = await run(src, "test") as number;
    expect(result).toBeGreaterThan(1577836800000);
  });

  it("getFullYear works for known dates", async () => {
    const src = `
      export function test(): number {
        const d = new Date(1234567890000);
        return d.getFullYear();
      }
    `;
    // 1234567890000 ms = 2009-02-13T23:31:30.000Z
    expect(await run(src, "test")).toBe(2009);
  });

  it("getMonth works for known dates", async () => {
    const src = `
      export function test(): number {
        const d = new Date(1234567890000);
        return d.getMonth();
      }
    `;
    // February is month 1 (0-indexed)
    expect(await run(src, "test")).toBe(1);
  });

  it("getDate works for known dates", async () => {
    const src = `
      export function test(): number {
        const d = new Date(1234567890000);
        return d.getDate();
      }
    `;
    // 13th day of February
    expect(await run(src, "test")).toBe(13);
  });

  it("getDay works for known dates", async () => {
    const src = `
      export function test(): number {
        const d = new Date(1234567890000);
        return d.getDay();
      }
    `;
    // 2009-02-13 is a Friday (day 5)
    expect(await run(src, "test")).toBe(5);
  });

  it("getHours works for known dates (UTC)", async () => {
    const src = `
      export function test(): number {
        const d = new Date(1234567890000);
        return d.getHours();
      }
    `;
    // 23 hours UTC
    expect(await run(src, "test")).toBe(23);
  });

  it("getMinutes works for known dates", async () => {
    const src = `
      export function test(): number {
        const d = new Date(1234567890000);
        return d.getMinutes();
      }
    `;
    expect(await run(src, "test")).toBe(31);
  });

  it("getSeconds works for known dates", async () => {
    const src = `
      export function test(): number {
        const d = new Date(1234567890000);
        return d.getSeconds();
      }
    `;
    expect(await run(src, "test")).toBe(30);
  });

  it("getMilliseconds works for known dates", async () => {
    const src = `
      export function test(): number {
        const d = new Date(1234567890000);
        return d.getMilliseconds();
      }
    `;
    expect(await run(src, "test")).toBe(0);
  });

  it("getMilliseconds works with non-zero ms", async () => {
    const src = `
      export function test(): number {
        const d = new Date(1234567890456);
        return d.getMilliseconds();
      }
    `;
    expect(await run(src, "test")).toBe(456);
  });

  it("epoch date components are correct", async () => {
    const src = `
      export function testYear(): number { return new Date(0).getFullYear(); }
      export function testMonth(): number { return new Date(0).getMonth(); }
      export function testDate(): number { return new Date(0).getDate(); }
      export function testDay(): number { return new Date(0).getDay(); }
      export function testHours(): number { return new Date(0).getHours(); }
      export function testMinutes(): number { return new Date(0).getMinutes(); }
      export function testSeconds(): number { return new Date(0).getSeconds(); }
    `;
    // 1970-01-01T00:00:00.000Z is Thursday
    expect(await run(src, "testYear")).toBe(1970);
    expect(await run(src, "testMonth")).toBe(0);
    expect(await run(src, "testDate")).toBe(1);
    expect(await run(src, "testDay")).toBe(4); // Thursday
    expect(await run(src, "testHours")).toBe(0);
    expect(await run(src, "testMinutes")).toBe(0);
    expect(await run(src, "testSeconds")).toBe(0);
  }, 30000);

  it("Date.valueOf() returns the same as getTime()", async () => {
    const src = `
      export function test(): number {
        const d = new Date(1234567890000);
        return d.valueOf();
      }
    `;
    expect(await run(src, "test")).toBe(1234567890000);
  });
});
