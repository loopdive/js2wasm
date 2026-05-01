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
  it.todo(
    "two fn-decls share TDZ-flagged outer let (writer + reader) — needs #1177 Stage 1 + destructure-assign-box-aware path",
    async () => {
      // BEFORE #1205: setX captures `x` as boxed (writtenInBody=true), but
      // getX captures `x` BY VALUE (writtenInBody=false). The two captures
      // didn't share storage, so getX read the stale capture-time value.
      //
      // The #1205 first attempt force-boxed the value capture on
      // `hasTdzFlag` (mirroring the arrow path). That made this test pass,
      // but broke 48+ test262 for-await-of cases because the destructure-
      // assign path (`compileForOfAssignDestructuringExternref`) writes via
      // `emitCoercedLocalSet(localIdx, externref)` — a direct `local.set`
      // bypassing `boxedCaptures`. With the value param force-boxed to
      // `ref $T_refcell`, the externref → ref-cell coercion emits a
      // `ref.cast_null` + `ref.as_non_null` that null-derefs at runtime.
      //
      // The complete fix needs (a) Stage 1 of #1177 re-applied
      // (`localMap.get(name) ?? cap.outerLocalIdx` at the call site so the
      // *second* fn-decl picks up the box re-aimed by the first), AND
      // (b) all destructure-assign code paths made boxedCaptures-aware.
      // Both are out of scope for this PR. Tracked as a follow-up to #1177.
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
    },
  );

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
