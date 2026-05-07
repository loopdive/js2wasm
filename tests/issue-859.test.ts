// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

/**
 * #859 — Map.forEach callback captures are immutable snapshots.
 *
 * Pre-fix: `compileArrowAsCallback` (in `src/codegen/closures.ts`) built the
 * callback's capture struct with `mutable: false` fields. Each invocation
 * read captures into fresh locals; mutations stayed local to the callback
 * frame and never propagated back to the enclosing function. The test262
 * case `Map/prototype/forEach/iterates-values-deleted-then-readded.js`
 * relied on that propagation: `if (count === 0)` was supposed to become
 * false on the second iteration. With immutable snapshots `count` always
 * read as 0, the delete+re-add fired every iteration, and the test hung.
 *
 * The fix wraps mutable captures in `(struct (field $value (mut T)))` ref
 * cells (mirroring `compileArrowAsClosure`'s `boxedCaptures` path). The
 * callback site stores the cell into the outer-local `__cb_rc_<name>_<id>`,
 * the cell's reference is what the capture struct holds, and writebacks
 * after the host call read the cell's `value` field back into the outer
 * local. Reads inside the callback go through `boxedCaptures` (via
 * `compileIdentifier`); writes go through the ref-cell `struct.set` (via
 * `compileAssignmentExpression`).
 *
 * Tests below run with `setExports` called — that's required because
 * `__make_callback`'s callback-maker resolves `__cb_N` lazily through the
 * runtime's `callbackState.getExports()`. Without `setExports` the
 * callback wrapper is a no-op (returns undefined silently).
 */

async function run(src: string): Promise<{ exports: Record<string, any> }> {
  const r = compile(src, { fileName: "test.ts" });
  expect(r.success, JSON.stringify(r.errors)).toBe(true);
  const imports = buildImports(r.imports, undefined, r.stringPool) as any;
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  if (typeof imports.setExports === "function") {
    imports.setExports(instance.exports);
  }
  return { exports: instance.exports as Record<string, any> };
}

describe("#859 — host callback captures propagate mutations", () => {
  it("Map.forEach: function-expression callback increments captured count", async () => {
    const { exports } = await run(`
      export function test(): number {
        const map = new Map<string, number>();
        map.set("foo", 0);
        map.set("bar", 1);
        let count = 0;
        map.forEach(function(_value, _key) {
          count = count + 1;
        });
        return count;
      }
    `);
    expect((exports.test as () => number)()).toBe(2);
  });

  it("Map.forEach: arrow callback increments captured count", async () => {
    const { exports } = await run(`
      export function test(): number {
        const map = new Map<string, number>();
        map.set("a", 1);
        map.set("b", 2);
        map.set("c", 3);
        let count = 0;
        map.forEach((_v, _k) => { count = count + 1; });
        return count;
      }
    `);
    expect((exports.test as () => number)()).toBe(3);
  });

  it("Map.forEach: postfix increment count++ propagates", async () => {
    const { exports } = await run(`
      export function test(): number {
        const map = new Map<string, number>();
        map.set("foo", 0);
        map.set("bar", 1);
        let count = 0;
        map.forEach(function(_v, _k) { count++; });
        return count;
      }
    `);
    expect((exports.test as () => number)()).toBe(2);
  });

  it("Map.forEach: direct assignment count = 7 propagates", async () => {
    const { exports } = await run(`
      export function test(): number {
        const map = new Map<string, number>();
        map.set("foo", 0);
        let count = 50;
        map.forEach(function(_v, _k) { count = 7; });
        return count;
      }
    `);
    expect((exports.test as () => number)()).toBe(7);
  });

  it("Set.forEach: callback mutation propagates", async () => {
    const { exports } = await run(`
      export function test(): number {
        const set = new Set<number>();
        set.add(1);
        set.add(2);
        set.add(3);
        let count = 0;
        set.forEach(function(_v) { count = count + 1; });
        return count;
      }
    `);
    expect((exports.test as () => number)()).toBe(3);
  });

  it("Array.forEach: callback mutation propagates (regression guard for inline path)", async () => {
    const { exports } = await run(`
      export function test(): number {
        const arr = [10, 20, 30, 40];
        let total = 0;
        arr.forEach(function(v) { total = total + v; });
        return total;
      }
    `);
    expect((exports.test as () => number)()).toBe(100);
  });

  it("test262 spec scenario: delete + re-add inside forEach terminates with count=3", async () => {
    // Mirrors test/built-ins/Map/prototype/forEach/iterates-values-deleted-then-readded.js.
    // Pre-#859: hangs forever because `if (count === 0)` is always true,
    // so each iteration deletes "foo" and re-adds it at the end of the
    // iteration order. With propagating captures, `count` becomes 1 after
    // the first iteration and the delete+re-add doesn't fire again.
    const { exports } = await run(`
      export function test(): number {
        const map = new Map<string, any>();
        map.set("foo", 0);
        map.set("bar", 1);
        let count = 0;
        let iterations = 0;
        map.forEach(function(_value, _key) {
          iterations = iterations + 1;
          if (iterations > 100) return;  // safety guard if fix regresses
          if (count === 0) {
            map.delete("foo");
            map.set("foo", "baz");
          }
          count = count + 1;
        });
        return count;
      }
    `);
    expect((exports.test as () => number)()).toBe(3);
  });

  it("two captured locals: both propagate independently", async () => {
    const { exports } = await run(`
      export function test(): number {
        const map = new Map<string, number>();
        map.set("a", 10);
        map.set("b", 20);
        let sum = 0;
        let n = 0;
        map.forEach(function(value, _k) {
          sum = sum + value;
          n = n + 1;
        });
        return sum * 100 + n; // 30 * 100 + 2 = 3002
      }
    `);
    expect((exports.test as () => number)()).toBe(3002);
  });
});
