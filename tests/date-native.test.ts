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
  const imports = buildImports(result);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return (instance.exports as any)[fn](...args);
}

describe("Issue #665: Native Wasm Date implementation", () => {
  it("new Date(ms).getTime() returns the millisecond timestamp", async () => {
    expect(
      await run(
        `
        export function test(): number {
          const d = new Date(1234567890123);
          return d.getTime();
        }
        `,
        "test",
      ),
    ).toBe(1234567890123);
  });

  it("new Date(ms).valueOf() returns the millisecond timestamp", async () => {
    expect(
      await run(
        `
        export function test(): number {
          const d = new Date(0);
          return d.valueOf();
        }
        `,
        "test",
      ),
    ).toBe(0);
  });

  it("new Date(2025, 0, 15).getFullYear() returns 2025", async () => {
    expect(
      await run(
        `
        export function test(): number {
          const d = new Date(2025, 0, 15);
          return d.getFullYear();
        }
        `,
        "test",
      ),
    ).toBe(2025);
  });

  it("new Date(2025, 0, 15).getMonth() returns 0 (January)", async () => {
    expect(
      await run(
        `
        export function test(): number {
          const d = new Date(2025, 0, 15);
          return d.getMonth();
        }
        `,
        "test",
      ),
    ).toBe(0);
  });

  it("new Date(2025, 0, 15).getDate() returns 15", async () => {
    expect(
      await run(
        `
        export function test(): number {
          const d = new Date(2025, 0, 15);
          return d.getDate();
        }
        `,
        "test",
      ),
    ).toBe(15);
  });

  it("new Date(2025, 5, 20, 14, 30, 45).getHours() returns 14", async () => {
    expect(
      await run(
        `
        export function test(): number {
          const d = new Date(2025, 5, 20, 14, 30, 45);
          return d.getHours();
        }
        `,
        "test",
      ),
    ).toBe(14);
  });

  it("new Date(2025, 5, 20, 14, 30, 45).getMinutes() returns 30", async () => {
    expect(
      await run(
        `
        export function test(): number {
          const d = new Date(2025, 5, 20, 14, 30, 45);
          return d.getMinutes();
        }
        `,
        "test",
      ),
    ).toBe(30);
  });

  it("new Date(2025, 5, 20, 14, 30, 45).getSeconds() returns 45", async () => {
    expect(
      await run(
        `
        export function test(): number {
          const d = new Date(2025, 5, 20, 14, 30, 45);
          return d.getSeconds();
        }
        `,
        "test",
      ),
    ).toBe(45);
  });

  it("new Date(2025, 5, 20, 14, 30, 45, 123).getMilliseconds() returns 123", async () => {
    expect(
      await run(
        `
        export function test(): number {
          const d = new Date(2025, 5, 20, 14, 30, 45, 123);
          return d.getMilliseconds();
        }
        `,
        "test",
      ),
    ).toBe(123);
  });

  it("Date.now() returns a number", async () => {
    expect(
      await run(
        `
        export function test(): number {
          return Date.now();
        }
        `,
        "test",
      ),
    ).toBe(0); // Pure Wasm: no clock, always 0
  });

  it("Date.UTC computes correct timestamp", async () => {
    expect(
      await run(
        `
        export function test(): number {
          return Date.UTC(1970, 0, 1);
        }
        `,
        "test",
      ),
    ).toBe(0);
  });

  it("Date.UTC(2025, 0, 1) matches JS Date.UTC", async () => {
    const expected = Date.UTC(2025, 0, 1);
    expect(
      await run(
        `
        export function test(): number {
          return Date.UTC(2025, 0, 1);
        }
        `,
        "test",
      ),
    ).toBe(expected);
  });

  it("new Date(ms) round-trips through getTime", async () => {
    const ts = 1700000000000;
    expect(
      await run(
        `
        export function test(): number {
          const d = new Date(${ts});
          return d.getTime();
        }
        `,
        "test",
      ),
    ).toBe(ts);
  });

  it("new Date(y,m,d).getTime() matches Date.UTC for same components", async () => {
    // new Date(2025, 5, 15) with multi-arg constructor uses UTC in our impl
    const expected = Date.UTC(2025, 5, 15);
    expect(
      await run(
        `
        export function test(): number {
          const d = new Date(2025, 5, 15);
          return d.getTime();
        }
        `,
        "test",
      ),
    ).toBe(expected);
  });

  it("setTime updates the timestamp", async () => {
    expect(
      await run(
        `
        export function test(): number {
          const d = new Date(0);
          d.setTime(999);
          return d.getTime();
        }
        `,
        "test",
      ),
    ).toBe(999);
  });

  it("getTimezoneOffset returns 0 (UTC)", async () => {
    expect(
      await run(
        `
        export function test(): number {
          const d = new Date(0);
          return d.getTimezoneOffset();
        }
        `,
        "test",
      ),
    ).toBe(0);
  });

  it("getDay returns correct day of week for epoch", async () => {
    // 1970-01-01 is Thursday = 4
    expect(
      await run(
        `
        export function test(): number {
          const d = new Date(0);
          return d.getDay();
        }
        `,
        "test",
      ),
    ).toBe(4);
  });

  it("getFullYear for epoch returns 1970", async () => {
    expect(
      await run(
        `
        export function test(): number {
          const d = new Date(0);
          return d.getFullYear();
        }
        `,
        "test",
      ),
    ).toBe(1970);
  });

  it("getMonth for epoch returns 0 (January)", async () => {
    expect(
      await run(
        `
        export function test(): number {
          const d = new Date(0);
          return d.getMonth();
        }
        `,
        "test",
      ),
    ).toBe(0);
  });

  it("getDate for epoch returns 1", async () => {
    expect(
      await run(
        `
        export function test(): number {
          const d = new Date(0);
          return d.getDate();
        }
        `,
        "test",
      ),
    ).toBe(1);
  });
});
