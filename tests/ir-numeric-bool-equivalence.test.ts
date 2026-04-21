// IR-path equivalence for the numeric/bool function subset.
//
// Each case compiles the same source twice — once with the legacy path
// (experimentalIR off) and once through the IR (experimentalIR on) — and
// asserts the exported function returns the same value for the same inputs.
// This is the "divergence gate" in #1131 §3 collapsed to a single test file
// for Phase 1.
//
// If any case here fails with `experimentalIR: true`, the selector or the
// builder/lower is widening beyond what it can correctly handle.

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
  // literals
  { name: "number literal", source: `export function f(): number { return 42; }`, fn: "f", args: [] },
  { name: "number decimal", source: `export function f(): number { return 3.14; }`, fn: "f", args: [] },
  { name: "bool true", source: `export function f(): boolean { return true; }`, fn: "f", args: [] },
  { name: "bool false", source: `export function f(): boolean { return false; }`, fn: "f", args: [] },
  // params
  { name: "param identity", source: `export function f(x: number): number { return x; }`, fn: "f", args: [7] },
  {
    name: "param identity bool",
    source: `export function f(b: boolean): boolean { return b; }`,
    fn: "f",
    args: [true],
  },
  // arithmetic
  {
    name: "add",
    source: `export function f(a: number, b: number): number { return a + b; }`,
    fn: "f",
    args: [2, 3],
  },
  {
    name: "sub",
    source: `export function f(a: number, b: number): number { return a - b; }`,
    fn: "f",
    args: [10, 3],
  },
  {
    name: "mul",
    source: `export function f(a: number, b: number): number { return a * b; }`,
    fn: "f",
    args: [4, 5],
  },
  {
    name: "div",
    source: `export function f(a: number, b: number): number { return a / b; }`,
    fn: "f",
    args: [20, 4],
  },
  // unary
  { name: "neg", source: `export function f(a: number): number { return -a; }`, fn: "f", args: [5] },
  { name: "unary plus", source: `export function f(a: number): number { return +a; }`, fn: "f", args: [9] },
  { name: "not true", source: `export function f(b: boolean): boolean { return !b; }`, fn: "f", args: [true] },
  { name: "not false", source: `export function f(b: boolean): boolean { return !b; }`, fn: "f", args: [false] },
  // comparisons → bool
  {
    name: "lt true",
    source: `export function f(a: number, b: number): boolean { return a < b; }`,
    fn: "f",
    args: [2, 3],
  },
  {
    name: "lt false",
    source: `export function f(a: number, b: number): boolean { return a < b; }`,
    fn: "f",
    args: [3, 2],
  },
  {
    name: "le",
    source: `export function f(a: number, b: number): boolean { return a <= b; }`,
    fn: "f",
    args: [3, 3],
  },
  {
    name: "gt",
    source: `export function f(a: number, b: number): boolean { return a > b; }`,
    fn: "f",
    args: [5, 2],
  },
  {
    name: "ge",
    source: `export function f(a: number, b: number): boolean { return a >= b; }`,
    fn: "f",
    args: [2, 2],
  },
  {
    name: "eq number",
    source: `export function f(a: number, b: number): boolean { return a === b; }`,
    fn: "f",
    args: [2, 2],
  },
  {
    name: "ne number",
    source: `export function f(a: number, b: number): boolean { return a !== b; }`,
    fn: "f",
    args: [2, 3],
  },
  {
    name: "eq bool",
    source: `export function f(a: boolean, b: boolean): boolean { return a === b; }`,
    fn: "f",
    args: [true, false],
  },
  // logical (bool operands)
  {
    name: "and t t",
    source: `export function f(a: boolean, b: boolean): boolean { return a && b; }`,
    fn: "f",
    args: [true, true],
  },
  {
    name: "and t f",
    source: `export function f(a: boolean, b: boolean): boolean { return a && b; }`,
    fn: "f",
    args: [true, false],
  },
  {
    name: "or f t",
    source: `export function f(a: boolean, b: boolean): boolean { return a || b; }`,
    fn: "f",
    args: [false, true],
  },
  // nested
  {
    name: "compound arithmetic",
    source: `export function f(a: number, b: number): number { return (a + b) * (a - b); }`,
    fn: "f",
    args: [5, 3],
  },
  {
    name: "chained compare",
    source: `export function f(a: number, b: number, c: number): boolean { return a < b && b < c; }`,
    fn: "f",
    args: [1, 2, 3],
  },
  {
    name: "paren unary",
    source: `export function f(a: number): number { return -(a * 2); }`,
    fn: "f",
    args: [3],
  },
];

describe("IR path — numeric/bool equivalence with legacy", () => {
  for (const c of CASES) {
    it(c.name, async () => {
      const { legacy, ir } = await dualRun(c.source, c.fn, c.args);
      expect(ir).toStrictEqual(legacy);
    });
  }
});

describe("IR path — byte-identical output for narrow subset", () => {
  // Constant-only returns lower to byte-identical output vs legacy because
  // tree emission reproduces the exact op sequence. This case is the direct
  // #1131 §7 bullet 6 "first divergence test" — converted to an assertion.
  it("return literal → byte-identical", () => {
    const source = `export function f(): number { return 42; }`;
    const a = compile(source, { nativeStrings: true }).binary;
    const b = compile(source, { nativeStrings: true, experimentalIR: true }).binary;
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it("return param → byte-identical", () => {
    const source = `export function f(x: number): number { return x; }`;
    const a = compile(source, { nativeStrings: true }).binary;
    const b = compile(source, { nativeStrings: true, experimentalIR: true }).binary;
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it("return a + b → byte-identical", () => {
    const source = `export function f(a: number, b: number): number { return a + b; }`;
    const a = compile(source, { nativeStrings: true }).binary;
    const b = compile(source, { nativeStrings: true, experimentalIR: true }).binary;
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });
});
