// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { createContext } from "node:vm";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { getTestSandbox } from "./test262-runner.js";

/**
 * #1310 — vm.createContext sandbox isolation for test262 global contamination.
 *
 * The test262 runner threads a `globalSandbox` (a fresh `vm.createContext({})`)
 * through `buildImports` so that a test which mutates `Array.prototype.push` /
 * `Object.prototype.hasOwnProperty` / etc. via `__extern_set` host imports
 * cannot leak that mutation into subsequent tests in the same shard.
 *
 * `resolveImport`'s `declared_global` branch now consults `globalSandbox`
 * before falling back to the real host `globalThis`, so when the runner
 * supplies a sandbox the resolved built-ins point into the sandbox copy.
 *
 * `getTestSandbox()` does a sentinel-keyed dirty check after each test:
 * if any tracked built-in changed identity, the sandbox is replaced with a
 * fresh `createContext` for the next test.
 */
describe("#1310 — globalSandbox option threads through buildImports", () => {
  it("sandbox-resolved Array is the sandbox's Array, not globalThis.Array", async () => {
    // Compile a tiny module that imports the global `Array` constructor and
    // exposes its identity to the host. Compare the externref-returned
    // value to `globalThis.Array` and to the sandbox's `Array`.
    const src = `
      declare const Array: any;
      export function getArray(): any {
        return Array;
      }
    `;
    const r = compile(src, { fileName: "t.ts" });
    expect(r.success).toBe(true);

    const sandbox = createContext({}) as Record<string, any>;
    const imports = buildImports(r.imports, undefined, r.stringPool, { globalSandbox: sandbox });
    const { instance } = await WebAssembly.instantiate(r.binary, imports);
    const fromWasm = (instance.exports.getArray as () => unknown)();
    expect(fromWasm).toBe(sandbox.Array);
    expect(fromWasm).not.toBe(globalThis.Array);
  });

  it("without globalSandbox, declared_global still resolves to host globalThis", async () => {
    const src = `
      declare const Array: any;
      export function getArray(): any {
        return Array;
      }
    `;
    const r = compile(src, { fileName: "t.ts" });
    expect(r.success).toBe(true);

    const imports = buildImports(r.imports, undefined, r.stringPool);
    const { instance } = await WebAssembly.instantiate(r.binary, imports);
    const fromWasm = (instance.exports.getArray as () => unknown)();
    expect(fromWasm).toBe(globalThis.Array);
  });

  it("globalThis intent resolves to the sandbox object when globalSandbox is supplied", async () => {
    const src = `
      export function getGlobal(): any {
        return globalThis;
      }
    `;
    const r = compile(src, { fileName: "t.ts" });
    expect(r.success).toBe(true);

    const sandbox = createContext({ marker: 42 }) as Record<string, any>;
    const imports = buildImports(r.imports, undefined, r.stringPool, { globalSandbox: sandbox });
    const { instance } = await WebAssembly.instantiate(r.binary, imports);
    const g = (instance.exports.getGlobal as () => unknown)();
    expect(g).toBe(sandbox);
  });
});

describe("#1310 — getTestSandbox dirty-checks built-in mutations", () => {
  it("returns the same sandbox when no built-in has been mutated", () => {
    const a = getTestSandbox();
    const b = getTestSandbox();
    expect(a).toBe(b);
  });

  it("replaces the sandbox when Array.prototype.push is rebound", () => {
    const a = getTestSandbox();
    const originalPush = (a.Array.prototype as any).push;

    // Mutate a sentinel: install a different function on Array.prototype.push.
    (a.Array.prototype as any).push = () => -1;

    const b = getTestSandbox();
    expect(b).not.toBe(a);
    // The fresh sandbox's push is the pristine vm-context built-in (not
    // the function we just installed).
    expect((b.Array.prototype as any).push).not.toBe((a.Array.prototype as any).push);

    // Restore the previous sandbox to avoid side effects on later tests.
    (a.Array.prototype as any).push = originalPush;
  });

  it("subsequent calls return the new sandbox until another mutation", () => {
    const fresh1 = getTestSandbox();
    const fresh2 = getTestSandbox();
    expect(fresh1).toBe(fresh2);
  });
});
