import { describe, it, expect } from "vitest";
import { compileToWasm } from "./helpers.js";

// #1334 — Object.defineProperty + delete descriptor fidelity (slice 1).
//
// Before this slice, the `delete obj.prop` operator on a WasmGC struct receiver
// only set the struct field to a sentinel — it never cleared the sidecar
// descriptor entry that `Object.defineProperty` had stored in `_wasmPropDescs`.
// So:
//
//   var obj = {};
//   Object.defineProperty(obj, "p", { configurable: true });
//   delete obj.p;
//   obj.hasOwnProperty("p");   // returned true (BUG — should be false)
//
// Three changes shipped together:
//
//   1. New `__delete_property(obj, key) -> i32` host import that clears both
//      the sidecar (_wasmStructProps) and descriptor (_wasmPropDescs) maps,
//      respecting the configurable flag.
//
//   2. Per-object tombstone WeakMap (`_wasmStructDeletedKeys`) populated on
//      successful delete and consulted by `__hasOwnProperty`,
//      `__propertyIsEnumerable`, etc. Re-assignment via `_sidecarSet` clears
//      the tombstone so the property re-appears as own.
//
//   3. Compile-time `hasOwnProperty` fast path now bails to the runtime
//      helper when the receiver variable has had any defineProperty call
//      observed (`ctx.definedPropertyFlags`) — otherwise the inlined
//      `i32.const 1` would override the runtime tombstone.
//
// This unblocks the largest cluster in `built-ins/Object/defineProperty/`
// (~40+ pass→fail tests where delete-after-defineProperty was wrong).

describe("#1334 — Object.defineProperty + delete tombstone", () => {
  it("delete-after-defineProperty makes hasOwnProperty return false (slice 1 spec)", async () => {
    const exp = await compileToWasm(`
      export function test(): number {
        var obj = {};
        Object.defineProperty(obj, "property", { configurable: true });
        var before = (obj as any).hasOwnProperty("property") ? 1 : 0;
        delete (obj as any).property;
        var after = (obj as any).hasOwnProperty("property") ? 1 : 0;
        return before * 10 + after;
      }
    `);
    // before=1, after=0 → 10
    expect(exp.test!()).toBe(10);
  });

  it("delete returns 1 (truthy) and remove is observable across hasOwnProperty", async () => {
    const exp = await compileToWasm(`
      export function deletes(): number {
        var obj = {};
        Object.defineProperty(obj, "p", { configurable: true });
        var dr = (delete (obj as any).p) ? 1 : 0;
        var present = (obj as any).hasOwnProperty("p") ? 1 : 0;
        return dr * 10 + present;
      }
    `);
    // delete=1, present=0 → 10
    expect(exp.deletes!()).toBe(10);
  });

  it.todo(
    "re-assigning a deleted property restores hasOwnProperty=true — slice 2 (struct.set tombstone clear)",
    async () => {
      // Tracked as a slice-2 follow-up: today, `obj.p = 7` after `delete obj.p`
      // emits a `struct.set` directly when the struct shape has the field.
      // `_sidecarSet` clears the tombstone, but `struct.set` doesn't, so
      // `hasOwnProperty("p")` still returns false. Slice 2 should either
      // (a) lower struct.set through a runtime helper that clears the
      // tombstone, or (b) extend the codegen to emit an explicit clear.
    },
  );

  it("delete on a property that was never defineProperty'd still works", async () => {
    const exp = await compileToWasm(`
      export function test(): number {
        var obj: any = { x: 5 };
        var before = obj.hasOwnProperty("x") ? 1 : 0;
        delete obj.x;
        var after = obj.hasOwnProperty("x") ? 1 : 0;
        return before * 10 + after;
      }
    `);
    // `obj: any` makes the receiver externref, so hasOwnProperty routes
    // through the runtime helper. Before the slice-1 fix it would have
    // returned `11` (both `true`) because struct-field presence drove the
    // answer. Now the post-delete tombstone correctly reports the field as
    // absent, matching JS spec: `before=1, after=0 → 10`.
    expect(exp.test!()).toBe(10);
  });
});
