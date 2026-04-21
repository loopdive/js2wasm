// IR-path equivalence for the let/const subset.
//
// Widening beyond the single-return body: `(let|const) <id> = <expr>; … return <expr>;`.
// Each case compiles the same source twice — once legacy, once through the IR —
// and asserts the exported function returns the same value for the same inputs.
//
// These cases are the "multi-use" stress test for the lowerer: `return x + x`
// forces the tree-emitter to materialize `x` to a Wasm local via `local.tee`
// rather than re-emit the defining tree twice.

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
    name: "const single-use",
    source: `export function f(): number { const y = 1; return y; }`,
    fn: "f",
    args: [],
  },
  {
    name: "let single-use",
    source: `export function f(a: number): number { let tmp = a + 1; return tmp * 2; }`,
    fn: "f",
    args: [5],
  },
  {
    name: "const multi-use — return x + x",
    source: `export function f(a: number, b: number): number { const x = a + b; return x + x; }`,
    fn: "f",
    args: [3, 4],
  },
  {
    name: "const multi-use — x * x (square via local)",
    source: `export function f(a: number): number { const x = a + 1; return x * x; }`,
    fn: "f",
    args: [7],
  },
  {
    name: "chain of locals",
    source: `export function f(a: number, b: number): number {
      const sum = a + b;
      const diff = a - b;
      return sum * diff;
    }`,
    fn: "f",
    args: [5, 3],
  },
  {
    name: "local feeds local",
    source: `export function f(a: number): number {
      const x = a * 2;
      const y = x + 1;
      return y;
    }`,
    fn: "f",
    args: [10],
  },
  {
    name: "bool local negated",
    source: `export function f(a: number, b: number): boolean {
      const lt = a < b;
      return !lt;
    }`,
    fn: "f",
    args: [5, 3],
  },
  {
    name: "bool local reused",
    source: `export function f(a: boolean): boolean {
      const t = !a;
      return t || t;
    }`,
    fn: "f",
    args: [false],
  },
  {
    name: "type annotation on local",
    source: `export function f(a: number): number {
      const x: number = a * a;
      return x + 1;
    }`,
    fn: "f",
    args: [4],
  },
  {
    name: "nested use — return x + x + x (triple use)",
    source: `export function f(a: number): number {
      const x = a + 1;
      return x + x + x;
    }`,
    fn: "f",
    args: [3],
  },
  {
    name: "two multi-use locals",
    source: `export function f(a: number, b: number): number {
      const x = a + b;
      const y = a - b;
      return x * x + y * y;
    }`,
    fn: "f",
    args: [3, 2],
  },
  {
    name: "multiple declarators in one let",
    source: `export function f(a: number): number {
      let x = a + 1, y = a - 1;
      return x * y;
    }`,
    fn: "f",
    args: [5],
  },
];

describe("IR path — let/const equivalence with legacy", () => {
  for (const c of CASES) {
    it(c.name, async () => {
      const { legacy, ir } = await dualRun(c.source, c.fn, c.args);
      expect(ir).toStrictEqual(legacy);
    });
  }
});
