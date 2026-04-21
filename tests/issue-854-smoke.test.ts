import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";
import { parseMeta, wrapTest } from "./test262-runner.ts";
import { readFileSync, existsSync } from "fs";
import { describe, it, expect } from "vitest";

async function runTest(source: string) {
  const r = compile(source, { fileName: "test.ts" });
  if (!r.success) {
    return `CE: ${r.errors.map((e) => e.message).join("; ")}`;
  }
  try {
    const importResult = buildImports(r.imports, undefined, r.stringPool);
    const { instance } = await WebAssembly.instantiate(r.binary, importResult);
    if (typeof (importResult as any).setExports === "function") {
      (importResult as any).setExports(instance.exports);
    }
    const ret = (instance.exports as any).test();
    return ret === 1 ? "PASS" : `FAIL (returned ${ret})`;
  } catch (e: any) {
    return `ERR: ${e.message}`;
  }
}

async function runTest262(path: string) {
  if (!existsSync(path)) return "SKIP: file not found";
  const src = readFileSync(path, "utf-8");
  const meta = parseMeta(src);
  const { source: w } = wrapTest(src, meta);
  return runTest(w);
}

const T262 = "/workspace/test262/test";

describe("issue-854 test262 cases", () => {
  it("Array.prototype.entries for-of", async () => {
    const r = await runTest262(`${T262}/language/statements/for-of/Array.prototype.entries.js`);
    console.log("Array.prototype.entries:", r);
  });

  it("Array.prototype.keys for-of", async () => {
    const r = await runTest262(`${T262}/language/statements/for-of/Array.prototype.keys.js`);
    console.log("Array.prototype.keys:", r);
    expect(r).toBe("PASS");
  });

  it("ArrayIteratorPrototype next/Int16Array", async () => {
    const r = await runTest262(`${T262}/built-ins/ArrayIteratorPrototype/next/Int16Array.js`);
    console.log("ArrayIteratorPrototype Int16Array:", r);
  });

  it("ArrayIteratorPrototype next/args-mapped-iteration", async () => {
    const r = await runTest262(`${T262}/built-ins/ArrayIteratorPrototype/next/args-mapped-iteration.js`);
    console.log("ArrayIteratorPrototype args-mapped:", r);
  });
});

describe("issue-854 Symbol.iterator tests", () => {
  it("array[Symbol.iterator] returns non-null", async () => {
    // This tests the element access path (not call path)
    const r = compile(
      `
      export function test(): number {
        const arr = [10, 20, 30];
        const fn = arr[Symbol.iterator];
        return fn !== null && fn !== undefined ? 1 : 0;
      }
    `,
      { fileName: "test.ts" },
    );
    console.log(
      "compile:",
      r.success ? "OK" : "FAIL",
      r.errors?.map((e: any) => e.message),
    );
    // Check which imports were requested
    console.log(
      "imports:",
      Object.keys(r.imports ?? {}).flatMap((mod) => Object.keys((r.imports as any)[mod])),
    );
    if (r.success) {
      try {
        const importResult = buildImports(r.imports, undefined, r.stringPool);
        // Hook into __extern_get to debug
        const origGet = (importResult as any).env?.__extern_get;
        if (origGet) {
          (importResult as any).env.__extern_get = (obj: any, key: any) => {
            const result = origGet(obj, key);
            if (typeof key === "symbol") {
              console.log("__extern_get sym:", {
                objType: typeof obj,
                objProto: Object.getPrototypeOf(obj),
                keyStr: key.toString(),
                isSI: key === Symbol.iterator,
                result,
              });
            }
            return result;
          };
        }
        const { instance } = await WebAssembly.instantiate(r.binary, importResult);
        if (typeof (importResult as any).setExports === "function") {
          (importResult as any).setExports(instance.exports);
        }
        const ret = (instance.exports as any).test();
        console.log("array[Symbol.iterator] non-null:", ret);
        expect(ret).toBe(1);
      } catch (e: any) {
        console.log("instantiate/run error:", e.message);
        throw e;
      }
    }
  });

  it("array[Symbol.iterator]() produces iterator", async () => {
    const r = await runTest(`
      export function test(): number {
        const arr = [10, 20, 30];
        const iter = arr[Symbol.iterator]();
        const r1 = iter.next();
        if (r1.done) return 0;
        if (r1.value !== 10) return 0;
        const r2 = iter.next();
        if (r2.value !== 20) return 0;
        const r3 = iter.next();
        if (r3.value !== 30) return 0;
        const r4 = iter.next();
        if (!r4.done) return 0;
        return 1;
      }
    `);
    console.log("array[Symbol.iterator]():", r);
    expect(r).toBe("PASS");
  });

  it("for-of using array[Symbol.iterator]()", async () => {
    const r = await runTest(`
      export function test(): number {
        const arr = [10, 20, 30];
        let sum = 0;
        for (const v of arr) {
          sum += v;
        }
        return sum === 60 ? 1 : 0;
      }
    `);
    console.log("basic for-of:", r);
    expect(r).toBe("PASS");
  });

  it("arr.entries() iteration count", async () => {
    const r = await runTest(`
      export function test(): number {
        const arr = [10, 20, 30];
        let count = 0;
        for (const x of arr.entries()) {
          count++;
        }
        return count === 3 ? 1 : 0;
      }
    `);
    console.log("arr.entries() count:", r);
    expect(r).toBe("PASS");
  });

  it("arr.keys() sum", async () => {
    const r = await runTest(`
      export function test(): number {
        const arr = [10, 20, 30];
        let sum = 0;
        for (const k of arr.keys()) {
          sum += k;
        }
        return sum === 3 ? 1 : 0;
      }
    `);
    console.log("arr.keys() sum:", r);
    expect(r).toBe("PASS");
  });

  it("arr.values() sum", async () => {
    const r = await runTest(`
      export function test(): number {
        const arr = [10, 20, 30];
        let sum = 0;
        for (const v of arr.values()) {
          sum += v;
        }
        return sum === 60 ? 1 : 0;
      }
    `);
    console.log("arr.values() sum:", r);
    expect(r).toBe("PASS");
  });
});
