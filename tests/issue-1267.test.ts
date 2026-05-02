// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1267 — Optimizer drops side-effectful method calls in statement position.
//
// Pre-fix bug: when an IR-claimed function had a method call in expression-
// statement position (e.g. `c.bump();` with the result discarded), the IR-
// to-Wasm lowerer (`src/ir/lower.ts:emitBlockBody`) silently dropped the
// instruction. The dead-code pass correctly kept the IR-side `class.call`
// (it's flagged side-effecting), but the lowerer's emission contract only
// emitted instructions that were either:
//   (a) void-producing (`result === null`), or
//   (b) cross-block-used, or
//   (c) intra-block-used (lazy emission at the use site).
// A side-effecting instr with an unused intra-block result hit none of
// those branches and got silently dropped. Visible mutation side effects
// (like `this.#count++`) were lost.
//
// Fix: in `emitBlockBody`, when an instruction's result has zero uses but
// the instruction is `isSideEffecting` (per dead-code.ts), eagerly emit the
// instruction tree followed by a Wasm `drop` op so the produced value is
// cleared from the operand stack. The DCE pass already keeps these
// instrs in the IR; this restores the matching emission.
//
// Reproduces with public AND private fields — not specific to `#name`
// syntax. This was originally surfaced during #1249 investigation.

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

function compileToWat(source: string): string {
  const r = compile(source, { fileName: "test.ts", emitWat: true });
  if (!r.success) throw new Error(`compile: ${r.errors[0]?.message}`);
  return r.wat;
}

// Count the number of standalone `call N` instructions inside the body
// of a named function in the WAT (after the param/result/local section).
// Excludes `local.get`, `local.set`, `i32.const`, etc.
function countCallsInRunBody(wat: string): number {
  const m = wat.match(/\(func \$run [\s\S]*?\n {2}\)/);
  if (!m) return -1;
  return (m[0].match(/^\s*call /gm) ?? []).length;
}

describe("#1267 — side-effectful method calls preserved in statement position", () => {
  it("class method with non-void return — three calls, three side effects (acceptance criterion 1)", async () => {
    const source = `
      class C {
        x: number = 0;
        bump(): number {
          this.x = this.x + 1;
          return this.x;
        }
      }
      export function run(): number {
        const c = new C();
        c.bump();
        c.bump();
        return c.bump();
      }
    `;
    const r = await compileAndInstantiate(source);
    expect((r.exports.run as () => number)()).toBe(3);
  });

  it("private method with non-void return — same fix applies", async () => {
    const source = `
      class C {
        #x: number = 0;
        #bump(): number {
          this.#x = this.#x + 1;
          return this.#x;
        }
        run(): number {
          this.#bump();
          this.#bump();
          return this.#bump();
        }
      }
      export function run(): number {
        return new C().run();
      }
    `;
    const r = await compileAndInstantiate(source);
    expect((r.exports.run as () => number)()).toBe(3);
  });

  it("multiple side-effectful methods called in sequence — all execute", async () => {
    const source = `
      class C {
        a: number = 0;
        b: number = 0;
        bumpA(): number { this.a = this.a + 1; return this.a; }
        bumpB(): number { this.b = this.b + 10; return this.b; }
        sum(): number { return this.a + this.b; }
      }
      export function run(): number {
        const c = new C();
        c.bumpA();
        c.bumpB();
        c.bumpA();
        c.bumpB();
        return c.sum();
      }
    `;
    const r = await compileAndInstantiate(source);
    // a = 2, b = 20, sum = 22
    expect((r.exports.run as () => number)()).toBe(22);
  });

  it("WAT regression guard — three calls produce three call ops in the body", () => {
    // Direct WAT-level check that the lowerer emits one `call` per
    // method-call statement, with a `drop` between them. This guards
    // against a future refactor of `emitBlockBody` re-introducing the
    // silent-drop pattern.
    const source = `
      class C {
        x: number = 0;
        bump(): number { this.x = this.x + 1; return this.x; }
      }
      export function run(): number {
        const c = new C();
        c.bump();
        c.bump();
        return c.bump();
      }
    `;
    const wat = compileToWat(source);
    // Expected: 1 call for `new C()` + 3 calls for bump() = 4 total
    expect(countCallsInRunBody(wat)).toBe(4);
    // And there should be at least 2 drops (the two unused bump() returns)
    const runBody = wat.match(/\(func \$run [\s\S]*?\n {2}\)/)?.[0] ?? "";
    expect((runBody.match(/^\s*drop/gm) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});

describe("#1267 — non-void method calls in non-IR-claimed (legacy) functions still work", () => {
  it("plain function with side-effecting calls in statement position", async () => {
    // The legacy emitter (used when run() touches a global and isn't
    // IR-claimable) was always correct — it emits `call; drop` pairs
    // explicitly. This test guards against the legacy path regressing.
    const source = `
      let g = 0;
      function bump(): number { g = g + 1; return g; }
      export function run(): number {
        bump();
        bump();
        return bump();
      }
    `;
    const r = await compileAndInstantiate(source);
    expect((r.exports.run as () => number)()).toBe(3);
  });
});
