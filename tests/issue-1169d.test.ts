// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1169d — IR Phase 4 Slice 4: simple class instances (new, field
// access/mutation, method calls) through the IR path.
//
// Each case compiles the same source twice — once with the legacy path
// (experimentalIR off) and once through the IR (experimentalIR on) — and
// asserts the exported function returns the same value for the same
// inputs. Both string backends are exercised for cases whose result is
// JS-representable.
//
// Slice 4 scope: outer (top-level) functions that USE class instances
// reach the IR path. Class methods/constructors stay on the legacy
// class-bodies path; the IR calls them via `class.new` and `class.call`,
// which lower to `call $<className>_new` / `call $<className>_<method>`
// against the legacy-allocated funcIdx. Inheritance, `super`, static
// methods, and dynamic property access remain out of scope.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const ENV_STUB = {
  env: {
    console_log_number: () => {},
    console_log_string: () => {},
    console_log_bool: () => {},
  },
};

type Outcome =
  | { kind: "ok"; value: unknown }
  | { kind: "compile_fail"; firstMessage: string }
  | { kind: "instantiate_fail" }
  | { kind: "invoke_fail" };

async function runOnce(
  source: string,
  fnName: string,
  args: ReadonlyArray<string | number | boolean>,
  experimentalIR: boolean,
  nativeStrings: boolean,
): Promise<Outcome> {
  const r = compile(source, { nativeStrings, experimentalIR });
  if (!r.success) {
    return { kind: "compile_fail", firstMessage: r.errors[0]?.message ?? "" };
  }
  let instance: WebAssembly.Instance;
  try {
    const imports = buildImports(r.imports, ENV_STUB.env, r.stringPool);
    ({ instance } = await WebAssembly.instantiate(r.binary, imports));
  } catch {
    return { kind: "instantiate_fail" };
  }
  try {
    const fn = instance.exports[fnName] as (...a: unknown[]) => unknown;
    return { kind: "ok", value: fn(...args) };
  } catch {
    return { kind: "invoke_fail" };
  }
}

async function dualRun(
  source: string,
  fnName: string,
  args: ReadonlyArray<string | number | boolean>,
  options: { nativeStrings: boolean },
): Promise<{ legacy: Outcome; ir: Outcome }> {
  const [legacy, ir] = await Promise.all([
    runOnce(source, fnName, args, false, options.nativeStrings),
    runOnce(source, fnName, args, true, options.nativeStrings),
  ]);
  return { legacy, ir };
}

interface Case {
  name: string;
  source: string;
  fn: string;
  args: ReadonlyArray<string | number | boolean>;
}

// Slice 4 cases — outer function uses a class internally OR receives
// a class-typed param. The outer is IR-claimable; class methods stay on
// the legacy path.
const CASES: Case[] = [
  // ---- new + field read ---------------------------------------------------
  {
    name: "new + field read",
    source: `
      class P { x: number; y: number; constructor(x: number, y: number) { this.x = x; this.y = y; } }
      export function f(): number { const p = new P(3, 4); return p.x; }
    `,
    fn: "f",
    args: [],
  },
  {
    name: "new + two field reads summed",
    source: `
      class P { x: number; y: number; constructor(x: number, y: number) { this.x = x; this.y = y; } }
      export function f(): number { const p = new P(3, 4); return p.x + p.y; }
    `,
    fn: "f",
    args: [],
  },
  // ---- new + method call --------------------------------------------------
  {
    name: "new + method call (no args)",
    source: `
      class P {
        x: number;
        y: number;
        constructor(x: number, y: number) { this.x = x; this.y = y; }
        sum(): number { return this.x + this.y; }
      }
      export function f(): number { const p = new P(3, 4); return p.sum(); }
    `,
    fn: "f",
    args: [],
  },
  {
    name: "new + method with arg",
    source: `
      class P {
        x: number;
        constructor(x: number) { this.x = x; }
        plus(y: number): number { return this.x + y; }
      }
      export function f(): number { const p = new P(10); return p.plus(5); }
    `,
    fn: "f",
    args: [],
  },
  // ---- method calling another method on this -----------------------------
  // Note: the method bodies stay on the legacy path, but `this.outer()` calls
  // through. The IR-claimed `f` only sees `instance.inner()`, which dispatches
  // to the legacy method body that contains the `this.outer()` call.
  {
    name: "method calls another method on this",
    source: `
      class C {
        a(): number { return this.b() + 1; }
        b(): number { return 41; }
      }
      export function f(): number { const c = new C(); return c.a(); }
    `,
    fn: "f",
    args: [],
  },
  // ---- field write --------------------------------------------------------
  {
    name: "field write then read",
    source: `
      class P { x: number; constructor(x: number) { this.x = x; } }
      export function f(): number { const p = new P(1); p.x = 42; return p.x; }
    `,
    fn: "f",
    args: [],
  },
  // ---- instance passed as argument ---------------------------------------
  {
    name: "instance passed to another IR function",
    source: `
      class P { x: number; constructor(x: number) { this.x = x; } }
      function readX(p: P): number { return p.x; }
      export function f(): number { const p = new P(99); return readX(p); }
    `,
    fn: "f",
    args: [],
  },
  // ---- ternary on method result ------------------------------------------
  {
    name: "ternary on field",
    source: `
      class P { x: number; constructor(x: number) { this.x = x; } }
      export function f(b: boolean): number {
        const p1 = new P(1);
        const p2 = new P(2);
        return b ? p1.x : p2.x;
      }
    `,
    fn: "f",
    args: [true],
  },
  // ---- multiple classes in same file -------------------------------------
  {
    name: "two classes in same file",
    source: `
      class A { v: number; constructor(v: number) { this.v = v; } }
      class B { w: number; constructor(w: number) { this.w = w; } }
      export function f(): number {
        const a = new A(10);
        const b = new B(20);
        return a.v + b.w;
      }
    `,
    fn: "f",
    args: [],
  },
  // ---- class with boolean field -------------------------------------------
  {
    name: "boolean field round-trip",
    source: `
      class Flag { ok: boolean; constructor(ok: boolean) { this.ok = ok; } }
      export function f(b: boolean): boolean { const fl = new Flag(b); return fl.ok; }
    `,
    fn: "f",
    args: [true],
  },
];

describe("#1169d — IR slice 4 (host strings)", () => {
  for (const c of CASES) {
    it(c.name, async () => {
      const { legacy, ir } = await dualRun(c.source, c.fn, c.args, { nativeStrings: false });
      expect(ir).toStrictEqual(legacy);
    });
  }
});

describe("#1169d — IR slice 4 (native strings, legacy-parity)", () => {
  for (const c of CASES) {
    it(c.name, async () => {
      const { legacy, ir } = await dualRun(c.source, c.fn, c.args, { nativeStrings: true });
      expect(ir).toStrictEqual(legacy);
    });
  }
});

// ---------------------------------------------------------------------------
// Coverage assertions — the slice-4 sources must compile cleanly with
// `experimentalIR: true` AND emit no IR-fallback errors. If the selector
// claimed a function and the lowerer threw mid-emission, those messages
// would show up in `result.errors`.
// ---------------------------------------------------------------------------

const COVERAGE_SOURCES = [
  // new + field read
  `class P { x: number; constructor(x: number) { this.x = x; } } export function f(): number { const p = new P(3); return p.x; }`,
  // new + method call
  `class P { x: number; constructor(x: number) { this.x = x; } get(): number { return this.x; } } export function f(): number { const p = new P(7); return p.get(); }`,
  // class-typed param
  `class P { x: number; constructor(x: number) { this.x = x; } } function readX(p: P): number { return p.x; } export function f(): number { return readX(new P(11)); }`,
  // field write
  `class P { x: number; constructor(x: number) { this.x = x; } } export function f(): number { const p = new P(1); p.x = 99; return p.x; }`,
];

describe("#1169d — slice 4 functions reach the IR path without errors", () => {
  for (const src of COVERAGE_SOURCES) {
    const label = src.slice(0, 80).replace(/\n/g, " ");
    it(`host: ${label}`, () => {
      const r = compile(src, { experimentalIR: true, nativeStrings: false });
      expect(r.success).toBe(true);
      const irErrors = r.errors.filter(
        (e) =>
          e.message.startsWith("IR path failed") ||
          e.message.startsWith("IR path: could not resolve") ||
          e.message.startsWith("ir/from-ast") ||
          e.message.startsWith("ir/lower"),
      );
      expect(irErrors).toEqual([]);
    });
    it(`native: ${label}`, () => {
      const r = compile(src, { experimentalIR: true, nativeStrings: true });
      expect(r.success).toBe(true);
      const irErrors = r.errors.filter(
        (e) =>
          e.message.startsWith("IR path failed") ||
          e.message.startsWith("IR path: could not resolve") ||
          e.message.startsWith("ir/from-ast") ||
          e.message.startsWith("ir/lower"),
      );
      expect(irErrors).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------
// Selector assertion — at least one of these sources claims a function in
// the IR selection. Verifies that slice 4 actually opens up new IR
// territory (rather than silently rejecting class shapes and falling
// back to legacy for everything).
// ---------------------------------------------------------------------------

import { planIrCompilation } from "../src/ir/select.js";
import { buildTypeMap } from "../src/ir/propagate.js";
import ts from "typescript";

function selectorClaims(source: string): readonly string[] {
  const sf = ts.createSourceFile("test.ts", source, ts.ScriptTarget.ESNext, true);
  // The selector consults a TypeMap built from the ts.Program. For the
  // selector-only assertion below we don't need cross-function type
  // propagation — typeMap is optional. Pass undefined.
  const sel = planIrCompilation(sf, { experimentalIR: true });
  return [...sel.funcs];
}

describe("#1169d — slice 4 selector claims at least one class-using function", () => {
  it("claims `f` that builds a Point and reads a field", () => {
    const src = `
      class P { x: number; constructor(x: number) { this.x = x; } }
      export function f(): number { const p = new P(3); return p.x; }
    `;
    const claimed = selectorClaims(src);
    expect(claimed).toContain("f");
  });

  it("claims `f` that calls a method on a class instance", () => {
    const src = `
      class P {
        x: number;
        constructor(x: number) { this.x = x; }
        get(): number { return this.x; }
      }
      export function f(): number { const p = new P(7); return p.get(); }
    `;
    const claimed = selectorClaims(src);
    expect(claimed).toContain("f");
  });

  it("claims a function that takes a class instance as a param", () => {
    const src = `
      class P { x: number; constructor(x: number) { this.x = x; } }
      function readX(p: P): number { return p.x; }
      export function f(): number { return readX(new P(11)); }
    `;
    const claimed = selectorClaims(src);
    // `readX` and `f` should both be claimed (call-graph closure).
    expect(claimed).toContain("readX");
    expect(claimed).toContain("f");
  });
});
