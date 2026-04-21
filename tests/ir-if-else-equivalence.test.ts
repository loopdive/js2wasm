// IR-path equivalence for if/else control flow.
//
// Widening from straight-line/ternary to real multi-block CFG: the selector
// now claims functions whose tail is `if (<cond>) <tail> else <tail>` where
// every path terminates with `return`. The IR represents this with a `br_if`
// terminator on the entry block and two successor blocks that each end in a
// `return` terminator — a shape that maps 1:1 onto structured Wasm
// `if/else/end` without needing a dominator tree.
//
// Byte-identity with the legacy emitter is NOT asserted for if/else —
// legacy uses block-form `if <T>` to produce a value, while the IR path
// uses structured-if with `return` inside each arm. Both produce equivalent
// runtime behavior for Phase 1 pure expressions.

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
    name: "bool param — then arm",
    source: `export function f(c: boolean): number { if (c) return 1; else return 2; }`,
    fn: "f",
    args: [true],
  },
  {
    name: "bool param — else arm",
    source: `export function f(c: boolean): number { if (c) return 1; else return 2; }`,
    fn: "f",
    args: [false],
  },
  {
    name: "comparison condition — then",
    source: `export function f(a: number, b: number): number { if (a < b) return a; else return b; }`,
    fn: "f",
    args: [3, 7],
  },
  {
    name: "comparison condition — else",
    source: `export function f(a: number, b: number): number { if (a < b) return a; else return b; }`,
    fn: "f",
    args: [9, 4],
  },
  {
    name: "arithmetic in each arm",
    source: `export function f(c: boolean, x: number): number { if (c) return x + 1; else return x - 1; }`,
    fn: "f",
    args: [true, 10],
  },
  {
    name: "arithmetic in each arm — else",
    source: `export function f(c: boolean, x: number): number { if (c) return x + 1; else return x - 1; }`,
    fn: "f",
    args: [false, 10],
  },
  {
    name: "cross-block local — then uses sum",
    source: `export function f(a: number, b: number): number {
      const sum = a + b;
      if (sum > 0) return sum;
      else return -sum;
    }`,
    fn: "f",
    args: [3, 4],
  },
  {
    name: "cross-block local — else uses sum",
    source: `export function f(a: number, b: number): number {
      const sum = a + b;
      if (sum > 0) return sum;
      else return -sum;
    }`,
    fn: "f",
    args: [-5, 2],
  },
  {
    name: "cross-block local used in cond and both arms",
    source: `export function f(a: number): number {
      const x = a * 2;
      if (x > 10) return x + 1;
      else return x - 1;
    }`,
    fn: "f",
    args: [6],
  },
  {
    name: "nested if in then",
    source: `export function f(a: number): number {
      if (a > 0) {
        if (a > 10) return 100;
        else return 10;
      } else return 0;
    }`,
    fn: "f",
    args: [15],
  },
  {
    name: "nested if in then — middle arm",
    source: `export function f(a: number): number {
      if (a > 0) {
        if (a > 10) return 100;
        else return 10;
      } else return 0;
    }`,
    fn: "f",
    args: [5],
  },
  {
    name: "nested if in then — else arm",
    source: `export function f(a: number): number {
      if (a > 0) {
        if (a > 10) return 100;
        else return 10;
      } else return 0;
    }`,
    fn: "f",
    args: [-3],
  },
  {
    name: "nested if in else",
    source: `export function f(a: number): number {
      if (a <= 0) return 0;
      else {
        if (a > 10) return 100;
        else return 10;
      }
    }`,
    fn: "f",
    args: [7],
  },
  {
    name: "returning bool from arms",
    source: `export function f(a: number): boolean { if (a > 0) return true; else return false; }`,
    fn: "f",
    args: [5],
  },
  {
    name: "returning bool from arms — else",
    source: `export function f(a: number): boolean { if (a > 0) return true; else return false; }`,
    fn: "f",
    args: [-5],
  },
  {
    name: "locals in each arm via block tail",
    source: `export function f(a: number): number {
      if (a > 0) {
        const d = a * 2;
        return d + 1;
      } else {
        const d = a * 3;
        return d - 1;
      }
    }`,
    fn: "f",
    args: [5],
  },
  {
    name: "locals in each arm via block tail — else",
    source: `export function f(a: number): number {
      if (a > 0) {
        const d = a * 2;
        return d + 1;
      } else {
        const d = a * 3;
        return d - 1;
      }
    }`,
    fn: "f",
    args: [-5],
  },
  {
    name: "three-way via nested if",
    source: `export function sign(a: number): number {
      if (a > 0) return 1;
      else {
        if (a < 0) return -1;
        else return 0;
      }
    }`,
    fn: "sign",
    args: [7],
  },
  {
    name: "three-way via nested if — zero",
    source: `export function sign(a: number): number {
      if (a > 0) return 1;
      else {
        if (a < 0) return -1;
        else return 0;
      }
    }`,
    fn: "sign",
    args: [0],
  },
  {
    name: "three-way via nested if — negative",
    source: `export function sign(a: number): number {
      if (a > 0) return 1;
      else {
        if (a < 0) return -1;
        else return 0;
      }
    }`,
    fn: "sign",
    args: [-3],
  },
  {
    name: "ternary inside if arm",
    source: `export function f(a: number): number {
      if (a > 0) return a > 10 ? 100 : 10;
      else return 0;
    }`,
    fn: "f",
    args: [7],
  },
  {
    name: "multi-use cross-block local",
    source: `export function f(a: number): number {
      const x = a + 1;
      if (x > 0) return x * x;
      else return -x;
    }`,
    fn: "f",
    args: [3],
  },
];

describe("IR path — if/else equivalence with legacy", () => {
  for (const c of CASES) {
    it(c.name, async () => {
      const { legacy, ir } = await dualRun(c.source, c.fn, c.args);
      expect(ir).toStrictEqual(legacy);
    });
  }
});
