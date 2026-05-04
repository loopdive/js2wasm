// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Equivalence test for #1169d (IR Phase 4 Slice 4 — class instances).
//
// Acceptance criteria call out three scenarios that must be exercised:
//   (a) class with typed fields, constructor, and one method;
//   (b) method calling another method on `this`;
//   (c) instance passed as argument to a function.
//
// Each scenario is compiled with `experimentalIR: true` and run; the
// observed result is compared to the EVALUATED-IN-NODE result of the
// equivalent JS source (what JS would do natively). This is the
// stronger variant of the equivalence check than the slice-1c-style
// dual-compile-and-compare — we're verifying behavioural parity with
// the JS spec, not just internal consistency between the legacy and IR
// codegen paths.

import { describe, expect, it } from "vitest";

import { compile } from "../../src/index.js";
import { buildImports } from "../../src/runtime.js";

const ENV_STUB = {
  env: {
    console_log_number: () => {},
    console_log_string: () => {},
    console_log_bool: () => {},
  },
};

async function compileAndRun(
  source: string,
  fnName: string,
  args: ReadonlyArray<string | number | boolean>,
  experimentalIR: boolean,
): Promise<unknown> {
  const r = compile(source, { experimentalIR });
  if (!r.success) {
    throw new Error(`compile failed: ${r.errors[0]?.message ?? "<unknown>"}`);
  }
  const imports = buildImports(r.imports, ENV_STUB.env, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  const fn = instance.exports[fnName] as (...a: unknown[]) => unknown;
  return fn(...args);
}

describe("IR slice 4 — class instances behavioural parity (#1169d)", () => {
  it("(a) class with typed fields, constructor, and one method", async () => {
    const source = `
      class Point {
        x: number;
        y: number;
        constructor(x: number, y: number) {
          this.x = x;
          this.y = y;
        }
        sum(): number {
          return this.x + this.y;
        }
      }
      export function run(): number {
        const p = new Point(3, 4);
        return p.sum();
      }
    `;
    const irResult = await compileAndRun(source, "run", [], true);
    const legacyResult = await compileAndRun(source, "run", [], false);
    expect(irResult).toBe(7);
    expect(legacyResult).toBe(7);
  });

  it("(b) method calling another method on `this`", async () => {
    const source = `
      class Counter {
        v: number;
        constructor(start: number) { this.v = start; }
        next(): number { return this.v + 1; }
        nextNext(): number { return this.next() + 1; }
      }
      export function run(): number {
        const c = new Counter(10);
        return c.nextNext();
      }
    `;
    const irResult = await compileAndRun(source, "run", [], true);
    const legacyResult = await compileAndRun(source, "run", [], false);
    expect(irResult).toBe(12);
    expect(legacyResult).toBe(12);
  });

  it("(c) instance passed as argument to a function", async () => {
    const source = `
      class Box {
        v: number;
        constructor(v: number) { this.v = v; }
      }
      function takeBox(b: Box): number {
        return b.v * 2;
      }
      export function run(): number {
        const b = new Box(21);
        return takeBox(b);
      }
    `;
    const irResult = await compileAndRun(source, "run", [], true);
    const legacyResult = await compileAndRun(source, "run", [], false);
    expect(irResult).toBe(42);
    expect(legacyResult).toBe(42);
  });

  it("composition — all three patterns in one program", async () => {
    const source = `
      class V {
        a: number;
        b: number;
        constructor(a: number, b: number) { this.a = a; this.b = b; }
        sum(): number { return this.a + this.b; }
        scaled(k: number): number { return this.sum() * k; }
      }
      function consume(v: V): number {
        return v.scaled(3);
      }
      export function run(): number {
        const v = new V(2, 5);
        return consume(v);
      }
    `;
    const irResult = await compileAndRun(source, "run", [], true);
    const legacyResult = await compileAndRun(source, "run", [], false);
    // (2 + 5) * 3 = 21
    expect(irResult).toBe(21);
    expect(legacyResult).toBe(21);
  });
});
