/**
 * Issue #1243 — for...in / Object.keys enumeration of compiled-object properties
 *
 * Verifies that WasmGC struct instances expose their field names through
 * `for...in`, `Object.keys`, `Object.values`, and `Object.entries` so that
 * lodash Tier 3 helpers (`_.pick`, `_.omit`, `_.mapValues`, `_.invert`,
 * `_.keys`, `_.values`, `_.entries`) work on user-supplied compiled objects.
 *
 * The infrastructure is provided by:
 *   - `__struct_field_names` (exported wasm function — comma-separated CSV)
 *   - `__sget_<name>` (exported wasm getters per field)
 *   - `__for_in_keys` / `__object_keys` host imports that combine struct
 *     fields with sidecar properties from `_wasmStructProps`.
 *
 * These tests pin the behaviour so it does not regress.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

async function run(src: string): Promise<unknown> {
  const r = compile(src, { fileName: "test.ts" });
  if (!r.success) throw new Error("CE: " + r.errors.map((e) => e.message).join("; "));
  const imps = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imps);
  if (imps.setExports) imps.setExports(instance.exports as Record<string, Function>);
  return (instance.exports as { test: () => unknown }).test();
}

describe("issue #1243 — for...in / Object.keys on compiled WasmGC structs", () => {
  describe("acceptance criterion 1: for...in yields keys in insertion order", () => {
    it("for...in over a plain compiled object yields all keys", async () => {
      expect(
        await run(`
          export function test(): number {
            const obj = { a: 1, b: 2, c: 3 };
            let count = 0;
            for (const _key in obj) count++;
            return count;
          }
        `),
      ).toBe(3);
    });

    it("for...in yields keys in source/insertion order", async () => {
      expect(
        await run(`
          export function test(): string {
            const obj = { foo: 1, bar: 2, baz: 3 };
            let result = "";
            for (const key in obj) {
              if (result.length > 0) result += ",";
              result += key;
            }
            return result;
          }
        `),
      ).toBe("foo,bar,baz");
    });

    it("for...in iteration count matches Object.keys length", async () => {
      expect(
        await run(`
          export function test(): number {
            const obj = { a: 1, b: 2, c: 3, d: 4, e: 5 };
            let forInCount = 0;
            for (const _k in obj) forInCount++;
            const objectKeysLen = Object.keys(obj).length;
            return forInCount === objectKeysLen ? forInCount : -1;
          }
        `),
      ).toBe(5);
    });

    it("for...in over a class instance yields field names", async () => {
      expect(
        await run(`
          class Point {
            x: number;
            y: number;
            constructor(x: number, y: number) { this.x = x; this.y = y; }
          }
          export function test(): string {
            const p = new Point(10, 20);
            let result = "";
            for (const k in p) {
              if (result.length > 0) result += ",";
              result += k;
            }
            return result;
          }
        `),
      ).toBe("x,y");
    });

    it("for...in over an empty object yields zero iterations", async () => {
      expect(
        await run(`
          export function test(): number {
            const obj: Record<string, number> = {};
            let count = 0;
            for (const _k in obj) count++;
            return count;
          }
        `),
      ).toBe(0);
    });
  });

  describe("acceptance criterion 2: Object.keys / Object.values / Object.entries", () => {
    it("Object.keys returns the field names of a compiled struct", async () => {
      expect(
        await run(`
          export function test(): string {
            const obj = { a: 1, b: 2, c: 3 };
            return Object.keys(obj).join(",");
          }
        `),
      ).toBe("a,b,c");
    });

    it("Object.keys preserves insertion order", async () => {
      expect(
        await run(`
          export function test(): string {
            const obj = { z: 1, a: 2, m: 3 };
            return Object.keys(obj).join(",");
          }
        `),
      ).toBe("z,a,m");
    });

    it("Object.keys works on class instances", async () => {
      expect(
        await run(`
          class Config {
            name: string;
            port: number;
            constructor(n: string, p: number) { this.name = n; this.port = p; }
          }
          export function test(): string {
            return Object.keys(new Config("server", 8080)).join(",");
          }
        `),
      ).toBe("name,port");
    });

    it("Object.values returns numeric field values in order", async () => {
      expect(
        await run(`
          export function test(): number {
            const obj = { a: 10, b: 20, c: 30 };
            const vals = Object.values(obj);
            let sum = 0;
            for (let i = 0; i < vals.length; i++) sum += vals[i] as number;
            return sum;
          }
        `),
      ).toBe(60);
    });

    it("Object.entries returns [key, value] pairs in insertion order", async () => {
      expect(
        await run(`
          export function test(): string {
            const obj = { x: 10, y: 20 };
            const entries = Object.entries(obj);
            let result = "";
            for (let i = 0; i < entries.length; i++) {
              if (result.length > 0) result += ";";
              result += (entries[i][0] as string) + "=" + (entries[i][1] as number);
            }
            return result;
          }
        `),
      ).toBe("x=10;y=20");
    });

    it("Object.keys returns empty array for empty object", async () => {
      expect(
        await run(`
          export function test(): number {
            return Object.keys({}).length;
          }
        `),
      ).toBe(0);
    });
  });

  describe("acceptance criterion 3: lodash-style helpers on compiled-object input", () => {
    it("_.pick — Object.keys + bracket assignment yields the picked subset", async () => {
      expect(
        await run(`
          function pick(obj: any, keys: string[]): any {
            const result: any = {};
            for (let i = 0; i < keys.length; i++) {
              const k = keys[i];
              result[k] = obj[k];
            }
            return result;
          }
          export function test(): number {
            const user = { name: "alice", age: 30, email: "a@a.com", role: "admin" };
            const picked = pick(user, ["name", "role"]);
            const keys = Object.keys(picked);
            if (keys.length !== 2) return 100 + keys.length;
            if (picked.name !== "alice") return 10;
            if (picked.role !== "admin") return 11;
            return 1;
          }
        `),
      ).toBe(1);
    });

    it("_.omit — Object.keys excludes the omitted field", async () => {
      // Validate via length + indexed access rather than `.join(",")` which
      // hits a separate any-typed Object.keys → string-array cast bug.
      expect(
        await run(`
          function omit(obj: any, keysToOmit: string[]): any {
            const result: any = {};
            const allKeys = Object.keys(obj);
            for (let i = 0; i < allKeys.length; i++) {
              const k = allKeys[i];
              let skip = false;
              for (let j = 0; j < keysToOmit.length; j++) {
                if (keysToOmit[j] === k) { skip = true; break; }
              }
              if (!skip) result[k] = obj[k];
            }
            return result;
          }
          export function test(): number {
            const user: any = { name: "alice", age: 30, password: "secret" };
            const safe = omit(user, ["password"]);
            const keys = Object.keys(safe);
            if (keys.length !== 2) return 100 + keys.length;
            // Verify each key by string equality rather than join.
            if (keys[0] !== "name") return 10;
            if (keys[1] !== "age") return 11;
            // Verify "password" is NOT in the enumerated keys (it was omitted).
            for (let i = 0; i < keys.length; i++) {
              if (keys[i] === "password") return 20;
            }
            return 1;
          }
        `),
      ).toBe(1);
    });

    it("_.mapValues — iterate keys, transform, store back", async () => {
      expect(
        await run(`
          export function test(): number {
            const obj = { a: 1, b: 2, c: 3 };
            const result: any = {};
            const keys = Object.keys(obj);
            for (let i = 0; i < keys.length; i++) {
              const k = keys[i];
              result[k] = (obj[k as "a"] as number) * 2;
            }
            // Re-read via Object.values to validate values landed correctly.
            const vals = Object.values(result);
            let sum = 0;
            for (let i = 0; i < vals.length; i++) sum += vals[i] as number;
            return sum;
          }
        `),
      ).toBe(12);
    });

    it("_.invert — swap keys and string values", async () => {
      expect(
        await run(`
          function invert(obj: any): any {
            const result: any = {};
            const keys = Object.keys(obj);
            for (let i = 0; i < keys.length; i++) {
              const k = keys[i];
              result[obj[k]] = k;
            }
            return result;
          }
          export function test(): string {
            const obj = { a: "x", b: "y", c: "z" };
            const inv = invert(obj);
            const keys = Object.keys(inv);
            return keys.join(",");
          }
        `),
      ).toBe("x,y,z");
    });

    it("_.keys / _.values / _.entries equivalents return parallel arrays", async () => {
      expect(
        await run(`
          export function test(): number {
            const obj = { a: 1, b: 2 };
            const ks = Object.keys(obj);
            const vs = Object.values(obj);
            const es = Object.entries(obj);
            if (ks.length !== 2 || vs.length !== 2 || es.length !== 2) return 0;
            // ks and es[*][0] must agree
            for (let i = 0; i < ks.length; i++) {
              if (ks[i] !== (es[i][0] as string)) return 10 + i;
              if ((vs[i] as number) !== (es[i][1] as number)) return 20 + i;
            }
            return 1;
          }
        `),
      ).toBe(1);
    });
  });

  describe("acceptance criterion 4: no regression vs prior for-in tests", () => {
    it("for...in supports break", async () => {
      expect(
        await run(`
          export function test(): number {
            const obj = { a: 1, b: 2, c: 3 };
            let count = 0;
            for (const _k in obj) {
              count++;
              if (count === 2) break;
            }
            return count;
          }
        `),
      ).toBe(2);
    });

    it("for...in supports continue", async () => {
      expect(
        await run(`
          export function test(): number {
            const obj = { a: 10, b: 20, c: 30 };
            let sum = 0;
            let i = 0;
            for (const _k in obj) {
              i++;
              if (i === 2) continue;
              sum += i;
            }
            return sum;
          }
        `),
      ).toBe(4);
    });

    it("for...in with bare identifier", async () => {
      expect(
        await run(`
          export function test(): number {
            const obj = { a: 1, b: 2 };
            let count = 0;
            let key: string;
            for (key in obj) count++;
            return count;
          }
        `),
      ).toBe(2);
    });
  });

  describe("cross-boundary: enumeration after struct passed to host", () => {
    it("for...in still works after JSON.stringify exposed the struct", async () => {
      expect(
        await run(`
          export function test(): number {
            const obj = { x: 1, y: 2, z: 3 };
            const _s = JSON.stringify(obj);
            let count = 0;
            for (const _k in obj) count++;
            return count;
          }
        `),
      ).toBe(3);
    });

    it("Object.keys still returns expected keys after host visibility", async () => {
      expect(
        await run(`
          export function test(): string {
            const obj = { x: 1, y: 2 };
            const _s = JSON.stringify(obj);
            return Object.keys(obj).join(",");
          }
        `),
      ).toBe("x,y");
    });
  });
});
