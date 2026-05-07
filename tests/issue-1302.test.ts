// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1302 — fixupModuleGlobalIndices over-shifted nested instr arrays.
//
// When `addStringConstantGlobal` appends a new global import, every existing
// `global.get`/`global.set` instruction with index ≥ threshold must be
// shifted up by 1. The walker tracks top-level body arrays in a `shifted`
// Set to avoid double-walking the same Instr[] reference, but it recurses
// into nested arrays (if.then, block.body, try.body, etc.) WITHOUT that
// dedup check. When a nested array is reachable from multiple top-level
// paths (e.g. `currentFunc.savedBodies[0]` AND `savedBodies[1]` because of
// the swap-then-embed pattern in destructuring-params or generator body
// wrap), its instructions get shifted twice — moving them past the declared
// global range and producing a Wasm validation error.
//
// The bug surfaces dramatically when compiling lodash flow.js, which has
// ~840 closures and ~88 string-constant imports — each of the 88 fixup
// calls applied 2× the intended shift to certain instructions, ending up
// 28 indices above the valid range.
//
// Fix: dedupe shifts per fixup call via a `WeakSet<Instr>` of already-
// shifted instructions and a `WeakSet<Instr[]>` of already-walked arrays.
// Multi-path reachability is now safe.

import { existsSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { compile, compileProject } from "../src/index.js";

describe("#1302 — fixupModuleGlobalIndices over-shift on shared nested arrays", () => {
  it("compiles and validates a synthetic case with shared nested instr structure", () => {
    // A program that exercises closures + string-constants + control flow
    // similar to lodash's _createFlow inner function. Many string literals
    // force repeated `addStringConstantGlobal` calls; the `if` branches
    // exercise nested instr arrays that the walker descends into.
    const source = `
      function makeFlow(funcs: any[]) {
        return function (this: any) {
          const args = arguments as any;
          const value = args[0];
          if (typeof funcs !== 'object') {
            throw new TypeError('Expected an array');
          }
          let result = value;
          let index = 0;
          while (++index < funcs.length) {
            if (typeof funcs[index] !== 'function') {
              throw new TypeError('Expected a function');
            }
            result = funcs[index].call(this, result);
          }
          return result;
        };
      }
      export function test(): number {
        const fns: any[] = [];
        const _flow = makeFlow(fns);
        return 1;
      }
    `;
    const r = compile(source, { fileName: "test.ts" });
    expect(r.success).toBe(true);
    expect(() => new WebAssembly.Module(r.binary)).not.toThrow();
  });

  const lodashEsInstalled = existsSync("node_modules/lodash-es/flow.js");
  const runIfInstalled = lodashEsInstalled ? it : it.skip;

  runIfInstalled("real-world repro: lodash flow.js validates after fix", () => {
    const r = compileProject("node_modules/lodash-es/flow.js", { allowJs: true });
    expect(r.success).toBe(true);
    expect(r.binary.length).toBeGreaterThan(0);
    // Pre-fix: threw "Invalid global index: 266 @+117088".
    // Post-fix: validates cleanly.
    expect(() => new WebAssembly.Module(r.binary)).not.toThrow();
  });
});
