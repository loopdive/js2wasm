import { describe, it, expect } from "vitest";
import { compileToWasm } from "./helpers.js";

// #1205 — TDZ flag boxing for async functions / generators (FNDECL-A1..A5).
//
// Before this fix, `compileNestedFunctionDeclaration` captured TDZ-flagged
// `let` bindings *by value* as leading params. When two fn-decls in the same
// scope captured the same `let` binding and ONE wrote to it while the OTHER
// only read, the reader observed a stale capture-time snapshot — Wasm's
// shared-storage invariant for boxed mutable captures didn't extend to the
// fn-decl path the way it does for the arrow-function path.
//
// FNDECL-A1..A5 mirror the arrow-function Stage 3 wiring to the fn-decl
// path:
//   - Force-box value captures whose TDZ flag is present in the outer fctx
//     (`isMutable = writtenInBody.has(name) || hasTdzFlag`).
//   - Add the boxed flag itself as an extra leading param so identifier
//     reads inside the body route through `boxedTdzFlags` (struct.get on
//     the i32 ref cell) rather than reading the stale capture-time snapshot.
//
// Sequencing note: this PR lands #1205 only. The companion `for-await-of`
// destructure-default cluster (test262
// `language/statements/for-await-of/async-{func,gen}-decl-dstr-*`) needs
// the Stage 1 re-application of #1177 on top of this work to fully retire
// — see plan/issues/sprints/46/1205.md for the staging plan.

describe("#1205 — async / generator fn-decl TDZ flag boxing", () => {
  it("two fn-decls share TDZ-flagged outer let (writer + reader)", async () => {
    // BEFORE #1205: setX captures `x` as boxed (writtenInBody=true), but
    // getX captures `x` BY VALUE (writtenInBody=false). The two captures
    // didn't share storage, so getX read the stale capture-time value.
    //
    // AFTER #1205: both fn-decls' captures are force-boxed because
    // `hasTdzFlag` is true for the let-decl. The outer fctx re-aims its
    // `localMap` and `boxedCaptures` on the first cap-prepend, so the
    // SECOND fn-decl invocation sees the same ref cell. setX writes 42
    // through the cell; getX reads 42 from the cell.
    const src = `
      export function harness(): number {
        let x: number = 0;
        function setX(): number { x = 42; return 0; }
        function getX(): number { return x; }
        setX();
        return getX();
      }
    `;
    const exports = await compileToWasm(src);
    expect(exports.harness()).toBe(42);
  });

  it("async fn captures TDZ-flagged outer let, observes mutations across calls", async () => {
    // The async fn body writes through the captured boxed ref cell, then
    // reads it back. The OUTER scope's read after the call must observe
    // the final value (validates that the box is shared, not duplicated).
    const src = `
      export function harness(): number {
        let counter: number = 0;
        async function bump(): Promise<number> {
          counter = counter + 1;
          return counter;
        }
        bump() as any as number; // counter: 0 → 1
        bump() as any as number; // counter: 1 → 2
        bump() as any as number; // counter: 2 → 3
        return counter;          // outer read of counter must be 3
      }
    `;
    const exports = await compileToWasm(src);
    expect(exports.harness()).toBe(3);
  });

  it("generator fn-decl with TDZ-flagged outer let — write-through capture", async () => {
    // Synchronous generator declared after the outer `let` it captures.
    // The generator body writes through the captured boxed ref cell, so
    // the outer scope sees the cumulative mutations.
    const src = `
      export function harness(): number {
        let x: number = 5;
        function* g(): Generator<number> {
          x = x + 10;
          yield x;
          x = x + 100;
          yield x;
        }
        const it = g() as any;
        const r1 = it.next();   // x: 5 → 15, yields 15
        const r2 = it.next();   // x: 15 → 115, yields 115
        return r1.value + r2.value + x; // 15 + 115 + 115 = 245
      }
    `;
    const exports = await compileToWasm(src);
    expect(exports.harness()).toBe(245);
  });
});
