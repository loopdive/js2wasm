/**
 * Tests for #986: BigInt serialization crash in try/finally and for-of generator close paths.
 *
 * Root cause: JSON.parse(JSON.stringify(...)) used to deep-clone IR instruction arrays
 * would throw "Do not know how to serialize a BigInt" when instructions contained
 * { op: "i64.const", value: BigInt(...) } nodes.
 *
 * Fix: use structuredClone() which handles BigInt natively.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { parseMeta, wrapTest } from "./test262-runner.js";
import { readFileSync, existsSync } from "fs";

// test262 files live in /workspace/test262 (shared across worktrees)
const TEST262_ROOT = "/workspace/test262/test";

function compileTest262(path: string) {
  const fullPath = `${TEST262_ROOT}/${path}`;
  if (!existsSync(fullPath)) throw new Error(`test262 file not found: ${path}`);
  const src = readFileSync(fullPath, "utf-8");
  const meta = parseMeta(src);
  const { source: w } = wrapTest(src, meta);
  return compile(w, { fileName: "test.ts" });
}

async function runTest262(path: string): Promise<string> {
  const r = compileTest262(path);
  if (!r.success) return `CE: ${r.errors[0]?.message}`;
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  const ret = (instance.exports as any).test();
  return ret === 1 ? "PASS" : `FAIL (${ret})`;
}

describe("#986 BigInt serialization in try/finally and for-of generator close", () => {
  it("should compile generator-close-via-break without BigInt serialization error", async () => {
    const result = await runTest262("language/statements/for-of/generator-close-via-break.js");
    expect(result).not.toMatch(/Do not know how to serialize a BigInt/);
    expect(result).not.toMatch(/^CE:/);
  });

  it("should compile generator-close-via-continue without BigInt serialization error", async () => {
    const result = await runTest262("language/statements/for-of/generator-close-via-continue.js");
    expect(result).not.toMatch(/Do not know how to serialize a BigInt/);
    expect(result).not.toMatch(/^CE:/);
  });

  it("should compile yield-star-from-finally without BigInt serialization error", async () => {
    const result = await runTest262("language/statements/for-of/yield-star-from-finally.js");
    expect(result).not.toMatch(/Do not know how to serialize a BigInt/);
    expect(result).not.toMatch(/^CE:/);
  });

  it("inline: try/finally in a generator should compile without BigInt serialization crash", () => {
    // Directly test that try/finally inside a generator compiles without crash.
    // The original bug: cloneFinally() used JSON.parse(JSON.stringify(...)) which
    // threw when finally instructions contained i64.const (BigInt) values.
    const src = `
function* gen() {
  try {
    yield 1;
  } finally {
    // finally block executes on generator close via return()
  }
}
function test() {
  var g = gen();
  g.next(); // advance to yield
  g.return(42); // close generator, invoking finally block
  return 1;
}
`;
    const r = compile(src, { fileName: "test.ts" });
    // The critical check: no BigInt serialization error
    if (!r.success) {
      const msg = r.errors[0]?.message ?? "";
      expect(msg).not.toMatch(/Do not know how to serialize a BigInt/);
    }
    // We just need it to compile successfully without crash
    expect(r.success).toBe(true);
  });

  it("inline: try/catch in a generator should compile without BigInt serialization crash", () => {
    // cloneCatchBody() had the same JSON.parse/stringify issue as cloneFinally()
    const src = `
function* gen() {
  try {
    yield 1;
  } catch (e) {
    // catch block
  }
}
function test() {
  var g = gen();
  g.next();
  g.throw(new Error("test")); // triggers catch block
  return 1;
}
`;
    const r = compile(src, { fileName: "test.ts" });
    if (!r.success) {
      const msg = r.errors[0]?.message ?? "";
      expect(msg).not.toMatch(/Do not know how to serialize a BigInt/);
    }
    expect(r.success).toBe(true);
  });
});
