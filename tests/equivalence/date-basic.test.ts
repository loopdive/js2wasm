import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("Date support (#707)", () => {
  it("new Date(ms).getTime() returns the timestamp", async () => {
    await assertEquivalent(
      `export function test(): number {
        const d = new Date(1234567890000);
        return d.getTime();
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("new Date(y,m,d).getFullYear() returns the year", async () => {
    await assertEquivalent(
      `export function test(): number {
        const d = new Date(2025, 0, 15);
        return d.getFullYear();
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("new Date(y,m,d).getMonth() returns 0-indexed month", async () => {
    await assertEquivalent(
      `export function test(): number {
        const d = new Date(2025, 5, 20);
        return d.getMonth();
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("new Date(y,m,d).getDate() returns the day", async () => {
    await assertEquivalent(
      `export function test(): number {
        const d = new Date(2025, 2, 21);
        return d.getDate();
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("new Date(ms).getUTCHours()", async () => {
    await assertEquivalent(
      `export function test(): number {
        const d = new Date(86400000 + 3600000 * 14);
        return d.getUTCHours();
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("new Date(ms).getMinutes()", async () => {
    await assertEquivalent(
      `export function test(): number {
        const d = new Date(86400000 + 60000 * 45);
        return d.getMinutes();
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("new Date(ms).getSeconds()", async () => {
    await assertEquivalent(
      `export function test(): number {
        const d = new Date(86400000 + 30000);
        return d.getSeconds();
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("Date.now() returns a number", async () => {
    await assertEquivalent(
      `export function test(): number {
        const now = Date.now();
        return typeof now === "number" ? 1 : 0;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("new Date(ms).valueOf() equals getTime()", async () => {
    await assertEquivalent(
      `export function test(): number {
        const d = new Date(1000000);
        return d.valueOf() === d.getTime() ? 1 : 0;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("new Date(ms).getUTCDay() returns day of week", async () => {
    await assertEquivalent(
      `export function test(): number {
        // 1970-01-01 was a Thursday (4)
        const d = new Date(0);
        return d.getUTCDay();
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("Date.UTC computes correct timestamp", async () => {
    await assertEquivalent(
      `export function test(): number {
        return Date.UTC(1970, 0, 2);
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("d.toString() returns a string", async () => {
    await assertEquivalent(
      `export function test(): number {
        const d = new Date(0);
        return typeof d.toString() === "string" ? 1 : 0;
      }`,
      [{ fn: "test", args: [] }],
    );
  });
});
