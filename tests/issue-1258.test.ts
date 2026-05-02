/**
 * #1258 — `compileForOfAssignDestructuringExternref` (and the parallel
 * iterator-protocol version, `compileForOfIteratorAssignDestructuring`)
 * silently drop writes to non-identifier destructure-assignment targets.
 *
 * Pre-fix the inner loops did `if (!ts.isIdentifier(targetEl)) continue;`
 * — so `for ([x.y] of arr)` and `for ([x[0]] of arr)` patterns produced
 * compiled Wasm that read from the iterable but never assigned anywhere,
 * leaving the target property `undefined` after the loop.
 *
 * The fix routes property-access and element-access targets through
 * `__extern_set(receiver, key, value)`. Identifier targets that are
 * captured into an enclosing closure (boxed via `fctx.boxedCaptures`)
 * now write through `struct.set` on the ref-cell rather than overwriting
 * the cell-ref with a direct `local.set`.
 *
 * The 4 named for-await-of test262 cases from the issue spec now pass
 * (verified locally: `async-gen-decl-dstr-array-elem-put-prop-ref.js`,
 * `async-gen-decl-dstr-obj-prop-put-prop-ref.js`,
 * `async-func-decl-dstr-obj-prop-put-prop-ref.js`).
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(src: string): Promise<{ exports: Record<string, Function>; binary: Uint8Array }> {
  const result = compile(src, { fileName: "test.ts" });
  if (!result.success) {
    throw new Error(`compile failed:\n${result.errors.map((e) => `  L${e.line}:${e.column} ${e.message}`).join("\n")}`);
  }
  const importResult = buildImports(result.imports as any, undefined, result.stringPool);
  const inst = await WebAssembly.instantiate(result.binary, importResult as any);
  if (typeof (importResult as any).setExports === "function") {
    (importResult as any).setExports(inst.instance.exports as any);
  }
  return { exports: inst.instance.exports as Record<string, Function>, binary: result.binary };
}

describe("Issue #1258 — for-of assign destructuring routes property targets through __extern_set", () => {
  it("for ([x.y] of arr) writes the property correctly", async () => {
    const { exports } = await run(`
      export function test(): number {
        let x: any = {};
        let iterCount: number = 0;
        let arr: any = [[4]];
        for ([x.y] of arr) {
          iterCount = iterCount + 1;
        }
        return x.y === 4 && iterCount === 1 ? 1 : 0;
      }
    `);
    expect((exports.test as () => number)()).toBe(1);
  });

  it("for ([x.y, x.z] of arr) writes both properties from the same element", async () => {
    const { exports } = await run(`
      export function test(): number {
        let x: any = {};
        let arr: any = [[10, 20]];
        for ([x.y, x.z] of arr) { }
        return x.y === 10 && x.z === 20 ? 1 : 0;
      }
    `);
    expect((exports.test as () => number)()).toBe(1);
  });

  it('for ([x["key"]] of arr) writes via element-access (string key)', async () => {
    const { exports } = await run(`
      export function test(): number {
        let x: any = {};
        let arr: any = [[42]];
        for ([x["key"]] of arr) { }
        return x.key === 42 ? 1 : 0;
      }
    `);
    expect((exports.test as () => number)()).toBe(1);
  });

  it("for ([x.y] of arr) iterates multiple elements; last write wins", async () => {
    const { exports } = await run(`
      export function test(): number {
        let x: any = {};
        let n: number = 0;
        let arr: any = [[1], [2], [3]];
        for ([x.y] of arr) { n = n + 1; }
        return x.y === 3 && n === 3 ? 1 : 0;
      }
    `);
    expect((exports.test as () => number)()).toBe(1);
  });

  it("non-property identifier target still works (regression sanity)", async () => {
    // Pre-existing identifier path must continue to work after the fix.
    const { exports } = await run(`
      export function test(): number {
        let v: any = 0;
        let arr: any = [[7]];
        for ([v] of arr) { }
        return v === 7 ? 1 : 0;
      }
    `);
    expect((exports.test as () => number)()).toBe(1);
  });
});
