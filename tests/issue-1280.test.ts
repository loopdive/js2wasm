// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1280 — IR selector: claim while / for loops with typed numeric state.
//
// Verifies that the canonical loop patterns (counter `++`, accumulator
// `+=`, `while` and C-style `for`) compile through the IR path under
// `experimentalIR: true` and produce the canonical
// `block { loop { <cond>; i32.eqz; br_if 1; <body>; <update?>; br 0 } }`
// Wasm pattern. The selector add-ons live in
// `src/ir/select.ts::isPhase1WhileStatement` /
// `isPhase1ForStatement`; the lowering is in
// `src/ir/from-ast.ts::lowerWhileStatement` /
// `lowerForStatement`; the structured-Wasm emission is in
// `src/ir/lower.ts::case "while.loop"` / `case "for.loop"`.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runIr(src: string): Promise<unknown> {
  const r = compile(src, { fileName: "test.ts", experimentalIR: true });
  if (!r.success) {
    throw new Error(`compile failed:\n${r.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const imps = buildImports(r.imports as never, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imps as never);
  if (typeof (imps as { setExports?: Function }).setExports === "function") {
    (imps as { setExports: Function }).setExports(instance.exports);
  }
  return (instance.exports as { test: () => unknown }).test();
}

async function watIr(src: string): Promise<string> {
  // Build the binary via the IR path, then disassemble through wasm-dis
  // (Binaryen) so the test can assert on the structured-Wasm pattern.
  const r = compile(src, { fileName: "test.ts", experimentalIR: true });
  if (!r.success) {
    throw new Error(`compile failed:\n${r.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const { exec, execFile } = await import("node:child_process");
  void exec;
  const { writeFile, mkdir } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = join(tmpdir(), `issue-1280-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  const wasmPath = join(dir, "module.wasm");
  await writeFile(wasmPath, r.binary);
  return await new Promise<string>((resolve, reject) => {
    execFile("/workspace/node_modules/.bin/wasm-dis", [wasmPath], { encoding: "utf-8" }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

describe("#1280 — IR selector claims while / for loops", () => {
  it("while loop: accumulate sum 0..9", async () => {
    expect(
      await runIr(`
        export function test(): number {
          let i: number = 0;
          let total: number = 0;
          while (i < 10) {
            total += i;
            i = i + 1;
          }
          return total;
        }
      `),
    ).toBe(45);
  });

  it("while loop: factorial via repeated multiplication", async () => {
    expect(
      await runIr(`
        export function test(): number {
          let n: number = 5;
          let r: number = 1;
          while (n > 0) {
            r *= n;
            n -= 1;
          }
          return r;
        }
      `),
    ).toBe(120);
  });

  it("for loop with `i++`: accumulate sum 0..4", async () => {
    expect(
      await runIr(`
        export function test(): number {
          let total: number = 0;
          for (let i: number = 0; i < 5; i++) {
            total += i;
          }
          return total;
        }
      `),
    ).toBe(10);
  });

  it("for loop with explicit `i = i + 1` update: accumulate sum 0..4", async () => {
    expect(
      await runIr(`
        export function test(): number {
          let total: number = 0;
          for (let i: number = 0; i < 5; i = i + 1) {
            total += i;
          }
          return total;
        }
      `),
    ).toBe(10);
  });

  it("for loop with compound `i += 2` update: even sum 0+2+4", async () => {
    expect(
      await runIr(`
        export function test(): number {
          let total: number = 0;
          for (let i: number = 0; i < 5; i += 2) {
            total += i;
          }
          return total;
        }
      `),
    ).toBe(6);
  });

  it("for loop with descending counter (`i--`)", async () => {
    expect(
      await runIr(`
        export function test(): number {
          let total: number = 0;
          for (let i: number = 5; i > 0; i--) {
            total += i;
          }
          return total;
        }
      `),
    ).toBe(15);
  });

  it("nested while in for: triangular sum (Σi*j)", async () => {
    expect(
      await runIr(`
        export function test(): number {
          let total: number = 0;
          for (let i: number = 0; i < 4; i++) {
            let j: number = 0;
            while (j < i) {
              total += j;
              j = j + 1;
            }
          }
          return total;
        }
      `),
    ).toBe(4); // i=0: 0; i=1: 0; i=2: 0+1; i=3: 0+1+2 → 4
  });

  it("WAT snapshot — for loop emits `block { loop { ... br_if ... br } }` IR pattern", async () => {
    const wat = await watIr(`
      export function test(): number {
        let total: number = 0;
        for (let i: number = 0; i < 5; i++) {
          total += i;
        }
        return total;
      }
    `);
    // The IR path emits the canonical structured loop. We assert the
    // signature pattern exists (block + loop + br_if for the cond
    // exit + br for the back-edge). The exact nesting / locals depend
    // on optimisation passes — match the structural shape only.
    expect(wat).toMatch(/\(block/);
    expect(wat).toMatch(/\(loop/);
    expect(wat).toMatch(/br_if/);
    // The loop must have a back-edge `br` to itself.
    expect(wat).toMatch(/\(br /);
  });

  it("WAT snapshot — while loop emits `block { loop { ... br_if ... br } }` IR pattern", async () => {
    const wat = await watIr(`
      export function test(): number {
        let i: number = 0;
        while (i < 5) {
          i = i + 1;
        }
        return i;
      }
    `);
    expect(wat).toMatch(/\(block/);
    expect(wat).toMatch(/\(loop/);
    expect(wat).toMatch(/br_if/);
    expect(wat).toMatch(/\(br /);
  });
});
