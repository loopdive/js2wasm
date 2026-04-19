// IR-path equivalence for conditional expressions (ternary `a ? b : c`).
//
// Lowered through Wasm `select`: both arms are evaluated, and the result is
// picked by the condition. This is runtime-equivalent to legacy's `if/else`
// block form because Phase 1 expressions are pure (no calls, no side effects,
// no exceptions) — the spec divergence between eager-both-arms (`select`)
// and lazy-one-arm (legacy `if`) only matters when arms can differ on side
// effects, which Phase 1 excludes by construction.
//
// Byte-identity with legacy is NOT asserted for ternaries — legacy uses the
// `if`/`else` structured op; IR uses `select`.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

const ENV = {
  env: {
    console_log_number: () => {},
    console_log_string: () => {},
    console_log_bool: () => {},
  },
};

async function dualRun(
  source: string,
  fnName: string,
  args: ReadonlyArray<number | boolean>,
): Promise<{ legacy: unknown; ir: unknown }> {
  const legacy = compile(source, { nativeStrings: true });
  if (!legacy.success) {
    throw new Error(`legacy compile failed:\n${legacy.errors.map((e) => e.message).join("\n")}`);
  }
  const ir = compile(source, { nativeStrings: true, experimentalIR: true });
  if (!ir.success) {
    throw new Error(`ir compile failed:\n${ir.errors.map((e) => e.message).join("\n")}`);
  }
  const [{ instance: lInst }, { instance: rInst }] = await Promise.all([
    WebAssembly.instantiate(legacy.binary, ENV),
    WebAssembly.instantiate(ir.binary, ENV),
  ]);
  const lFn = lInst.exports[fnName] as (...a: unknown[]) => unknown;
  const rFn = rInst.exports[fnName] as (...a: unknown[]) => unknown;
  return { legacy: lFn(...args), ir: rFn(...args) };
}

const CASES: {
  name: string;
  source: string;
  fn: string;
  args: ReadonlyArray<number | boolean>;
}[] = [
  {
    name: "bool condition, true branch",
    source: `export function f(c: boolean): number { return c ? 1 : 2; }`,
    fn: "f",
    args: [true],
  },
  {
    name: "bool condition, false branch",
    source: `export function f(c: boolean): number { return c ? 1 : 2; }`,
    fn: "f",
    args: [false],
  },
  {
    name: "comparison condition",
    source: `export function f(a: number, b: number): number { return a < b ? a : b; }`,
    fn: "f",
    args: [3, 7],
  },
  {
    name: "comparison condition, other branch",
    source: `export function f(a: number, b: number): number { return a < b ? a : b; }`,
    fn: "f",
    args: [9, 4],
  },
  {
    name: "ternary returning bool",
    source: `export function f(a: number): boolean { return a > 0 ? true : false; }`,
    fn: "f",
    args: [5],
  },
  {
    name: "nested ternary",
    source: `export function f(a: number): number {
      return a > 0 ? (a > 10 ? 100 : 10) : 0;
    }`,
    fn: "f",
    args: [7],
  },
  {
    name: "ternary with let and multi-use",
    source: `export function f(a: number, b: number): number {
      const m = a * b;
      return m > 0 ? m + 1 : m - 1;
    }`,
    fn: "f",
    args: [3, 4],
  },
  {
    name: "ternary in arithmetic",
    source: `export function f(a: number): number {
      return 10 + (a > 0 ? a : -a);
    }`,
    fn: "f",
    args: [-3],
  },
];

describe("IR path — ternary equivalence with legacy", () => {
  for (const c of CASES) {
    it(c.name, async () => {
      const { legacy, ir } = await dualRun(c.source, c.fn, c.args);
      expect(ir).toStrictEqual(legacy);
    });
  }
});
