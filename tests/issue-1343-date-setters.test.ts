/**
 * #1343 Slice 2 — time-of-day setters
 *
 * Adds Wasm-native implementations of:
 *   - setMilliseconds(ms) / setUTCMilliseconds(ms)
 *   - setSeconds(s, ms?) / setUTCSeconds(s, ms?)
 *   - setMinutes(m, s?, ms?) / setUTCMinutes(m, s?, ms?)
 *   - setHours(h, m?, s?, ms?) / setUTCHours(h, m?, s?, ms?)
 *
 * Strategy: keep the day-of-epoch portion of the timestamp fixed, rebuild
 * the ms-of-day portion from either the user-supplied argument (ToInteger
 * via i64.trunc_sat_f64_s) or the current component value when an arg is
 * omitted. UTC variants share implementations because the Wasm Date is
 * already represented in UTC (no DST adjustment).
 *
 * Pre-fix behavior: these setter method names weren't in the
 * `DATE_METHODS` allowlist, so calls fell through to externref dispatch
 * which failed at runtime. ~58 of the 174 `built-ins/Date/prototype`
 * test262 fails are in this slice.
 *
 * Slice 1 (NaN propagation / Invalid Date sentinel) and Slice 3 (calendar
 * setters: setDate / setMonth / setFullYear) are tracked in the issue
 * file and will land in follow-up PRs.
 */
import { describe, expect, it } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

describe("issue #1343 Slice 2 — Date time-of-day setters", () => {
  it("setMilliseconds replaces just the ms component", async () => {
    const source = `
export function test(): number {
  const d = new Date(2026, 0, 15, 12, 30, 45, 123);
  d.setMilliseconds(789);
  return d.getMilliseconds();
}
`;
    const exports = await compileToWasm(source);
    expect(exports.test!()).toBe(789);
  });

  it("setMilliseconds preserves h/m/s and updates ms", async () => {
    const source = `
export function test(): number {
  const d = new Date(2026, 0, 15, 12, 30, 45, 123);
  d.setMilliseconds(500);
  return d.getHours() * 1000000 + d.getMinutes() * 10000 + d.getSeconds() * 100 + Math.floor(d.getMilliseconds() / 10);
}
`;
    const exports = await compileToWasm(source);
    // 12*1e6 + 30*1e4 + 45*100 + 50 = 12,304,550
    expect(exports.test!()).toBe(12304550);
  });

  it("setSeconds(s, ms?) replaces s and ms when both provided", async () => {
    const source = `
export function test(): number {
  const d = new Date(2026, 0, 15, 12, 30, 45, 123);
  d.setSeconds(20, 999);
  return d.getSeconds() * 1000 + d.getMilliseconds();
}
`;
    const exports = await compileToWasm(source);
    expect(exports.test!()).toBe(20999);
  });

  it("setSeconds(s) preserves ms when omitted", async () => {
    const source = `
export function test(): number {
  const d = new Date(2026, 0, 15, 12, 30, 45, 123);
  d.setSeconds(20);
  return d.getSeconds() * 1000 + d.getMilliseconds();
}
`;
    const exports = await compileToWasm(source);
    expect(exports.test!()).toBe(20123);
  });

  it("setMinutes(m, s, ms) replaces all three", async () => {
    const source = `
export function test(): number {
  const d = new Date(2026, 0, 15, 12, 30, 45, 123);
  d.setMinutes(50, 10, 5);
  return d.getMinutes() * 1000000 + d.getSeconds() * 1000 + d.getMilliseconds();
}
`;
    const exports = await compileToWasm(source);
    expect(exports.test!()).toBe(50010005);
  });

  it("setHours(h, m, s, ms) — full four-arg form", async () => {
    const source = `
export function test(): number {
  const d = new Date(2026, 0, 15, 12, 30, 45, 123);
  d.setHours(7, 8, 9, 10);
  return d.getHours() * 1000000000 + d.getMinutes() * 1000000 + d.getSeconds() * 1000 + d.getMilliseconds();
}
`;
    const exports = await compileToWasm(source);
    // 7e9 + 8e6 + 9e3 + 10 = 7,008,009,010
    expect(exports.test!()).toBe(7008009010);
  });

  it("setHours(h) preserves m/s/ms when only h provided", async () => {
    const source = `
export function test(): number {
  const d = new Date(2026, 0, 15, 12, 30, 45, 123);
  d.setHours(7);
  return d.getHours() * 1000000000 + d.getMinutes() * 1000000 + d.getSeconds() * 1000 + d.getMilliseconds();
}
`;
    const exports = await compileToWasm(source);
    expect(exports.test!()).toBe(7030045123);
  });

  it("setHours overflow rolls into the next day", async () => {
    const source = `
export function test(): number {
  const d = new Date(2026, 0, 15, 12, 0, 0, 0);
  d.setHours(36);  // 36h = 1 day + 12h
  return d.getDate();
}
`;
    const exports = await compileToWasm(source);
    expect(exports.test!()).toBe(16);
  });

  it("setUTCHours behaves identically (Wasm Date is UTC)", async () => {
    const source = `
export function test(): number {
  const d = new Date(2026, 0, 15, 12, 30, 45, 123);
  d.setUTCHours(7, 8, 9, 10);
  return d.getUTCHours() * 1000000000 + d.getUTCMinutes() * 1000000 + d.getUTCSeconds() * 1000 + d.getUTCMilliseconds();
}
`;
    const exports = await compileToWasm(source);
    expect(exports.test!()).toBe(7008009010);
  });

  it("setMilliseconds returns the new TimeValue", async () => {
    const source = `
export function test(): number {
  const d = new Date(2026, 0, 15, 12, 30, 45, 123);
  const ts = d.setMilliseconds(456);
  return ts === d.getTime() ? 1 : 0;
}
`;
    const exports = await compileToWasm(source);
    expect(exports.test!()).toBe(1);
  });

  it("setSeconds with negative seconds underflows correctly (floor-mod)", async () => {
    const source = `
export function test(): number {
  const d = new Date(2026, 0, 15, 12, 30, 0, 0);
  d.setSeconds(-30);  // -30s before 12:30:00 = 12:29:30
  return d.getMinutes() * 100 + d.getSeconds();
}
`;
    const exports = await compileToWasm(source);
    expect(exports.test!()).toBe(2930);
  });
});
