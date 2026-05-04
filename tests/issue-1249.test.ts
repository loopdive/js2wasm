// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1249 — Class private fields and methods (`#name` syntax).
//
// Status when this PR was opened: investigation showed the support is
// **already implemented** end-to-end. The codegen layers (binary-ops,
// class-bodies, expressions, expressions/assignment, typeof-delete,
// property-access) all consult `ts.isPrivateIdentifier` and mangle
// `#foo` → `__priv_foo` consistently before lowering to struct fields
// or method dispatch. The wasm-level storage model is identical to
// regular fields — private semantics are a TS/JS language-level
// concept enforced before codegen runs.
//
// This test file formalizes that support so future regressions surface
// in CI rather than via Hono Tier 2 stress tests (#1244). It covers:
//   - Private field read / write
//   - Private method call
//   - Private + public field side-by-side (no name collision via mangle)
//   - Private array field with .push() / .length (Hono Node-like pattern)
//   - Private field default initializer
//   - Self-referential private state (a method that writes #x and
//     a separate method that reads it)

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const ENV_STUB = {
  console_log_number: () => {},
  console_log_string: () => {},
  console_log_bool: () => {},
};

interface InstantiateResult {
  exports: Record<string, unknown>;
}

async function compileAndInstantiate(source: string): Promise<InstantiateResult> {
  const r = compile(source, { fileName: "test.ts" });
  if (!r.success) {
    throw new Error(`compile failed: ${r.errors.map((e) => `L${e.line}:${e.column} ${e.message}`).join(" | ")}`);
  }
  const built = buildImports(r.imports, ENV_STUB, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, {
    env: built.env,
    string_constants: built.string_constants,
  });
  return { exports: instance.exports as Record<string, unknown> };
}

describe("#1249 — class private fields (#name syntax)", () => {
  it("private field — read after default init", async () => {
    const source = `
      class C {
        #v: number = 42;
        getV(): number { return this.#v; }
      }
      export function run(): number { return new C().getV(); }
    `;
    const r = await compileAndInstantiate(source);
    expect((r.exports.run as () => number)()).toBe(42);
  });

  it("private field — write then read", async () => {
    const source = `
      class C {
        #x: number = 0;
        set(v: number): void { this.#x = v; }
        get(): number { return this.#x; }
      }
      export function run(): number {
        const c = new C();
        c.set(99);
        return c.get();
      }
    `;
    const r = await compileAndInstantiate(source);
    expect((r.exports.run as () => number)()).toBe(99);
  });

  it("private + public field side-by-side — no name collision via mangling", async () => {
    // Both `foo` and `#foo` are valid simultaneously per TC39 Class Fields
    // spec. The codegen mangles `#foo` → `__priv_foo` so the struct has
    // two distinct fields.
    const source = `
      class C {
        foo: number = 1;
        #foo: number = 2;
        getPublic(): number { return this.foo; }
        getPrivate(): number { return this.#foo; }
      }
      export function runPublic(): number { return new C().getPublic(); }
      export function runPrivate(): number { return new C().getPrivate(); }
    `;
    const r = await compileAndInstantiate(source);
    expect((r.exports.runPublic as () => number)()).toBe(1);
    expect((r.exports.runPrivate as () => number)()).toBe(2);
  });
});

describe("#1249 — class private methods (#name syntax)", () => {
  it("private method — called from a public method on the same class", async () => {
    const source = `
      class C {
        #compute(x: number): number { return x * 2; }
        go(x: number): number { return this.#compute(x); }
      }
      export function run(x: number): number { return new C().go(x); }
    `;
    const r = await compileAndInstantiate(source);
    expect((r.exports.run as (x: number) => number)(5)).toBe(10);
  });

  it("private method — chained calls within the class", async () => {
    const source = `
      class C {
        #double(x: number): number { return x * 2; }
        #triple(x: number): number { return x * 3; }
        process(x: number): number { return this.#double(this.#triple(x)); }
      }
      export function run(x: number): number { return new C().process(x); }
    `;
    const r = await compileAndInstantiate(source);
    expect((r.exports.run as (x: number) => number)(4)).toBe(24);
  });
});

describe("#1249 — Hono Node-like pattern (acceptance criterion 3)", () => {
  it("private array field with push() + length", async () => {
    // Mirrors the structural pattern from Hono's TrieRouter Node class:
    //   class Node { #methods: number[] = []; addRoute(m: number) { this.#methods.push(m); } }
    // The exact Hono uses `Array<Readonly<Result<T>>>` which involves
    // generics and Readonly utility types — those are orthogonal to
    // private-field support. This test pins the private-field-with-array
    // pattern.
    const source = `
      class Node {
        #methods: number[] = [];
        addRoute(method: number): void {
          this.#methods.push(method);
        }
        size(): number {
          return this.#methods.length;
        }
        hasAny(): boolean {
          return this.#methods.length > 0;
        }
      }
      export function runEmpty(): boolean { return new Node().hasAny(); }
      export function runAfterAdd(): number {
        const n = new Node();
        n.addRoute(1);
        n.addRoute(2);
        n.addRoute(3);
        return n.size();
      }
    `;
    const r = await compileAndInstantiate(source);
    // hasAny() returns boolean; export value is i32 (0/1).
    expect((r.exports.runEmpty as () => number)()).toBe(0);
    expect((r.exports.runAfterAdd as () => number)()).toBe(3);
  });

  it("multiple private fields used together (state encapsulation)", async () => {
    // Avoid the unrelated optimizer-elision bug for repeated method
    // calls (filed as a follow-up — affects both public AND private
    // class methods in IR-claimed top-level functions). Instead we
    // accumulate via direct field reads/writes inside a single method
    // body, which exercises the same #count/#step state but doesn't
    // depend on expression-statement preservation across multiple
    // method calls from the entry function.
    const source = `
      class Counter {
        #count: number = 0;
        #step: number;
        constructor(step: number) {
          this.#step = step;
        }
        runThreeTicks(): number {
          this.#count = this.#count + this.#step;
          this.#count = this.#count + this.#step;
          this.#count = this.#count + this.#step;
          return this.#count;
        }
      }
      export function run(): number {
        return new Counter(7).runThreeTicks();
      }
    `;
    const r = await compileAndInstantiate(source);
    // 0 + 7 + 7 + 7 = 21
    expect((r.exports.run as () => number)()).toBe(21);
  });
});
