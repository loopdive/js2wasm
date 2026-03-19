import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { wrapTest } from "./test262-runner.js";
import { buildImports } from "../src/runtime.js";
import * as fs from "fs";

/** Compile and instantiate to catch Wasm validation errors */
async function compileAndValidate(source: string) {
  const result = compile(source);
  if (!result.success) {
    return { compileSuccess: false, instantiateSuccess: false, error: result.errors.map(e => e.message).join("; "), wat: result.wat };
  }
  try {
    const imports = buildImports(result.imports, undefined, result.stringPool);
    await WebAssembly.instantiate(result.binary, imports);
    return { compileSuccess: true, instantiateSuccess: true, error: null, wat: result.wat };
  } catch (e: any) {
    return { compileSuccess: true, instantiateSuccess: false, error: e.message, wat: result.wat };
  }
}

async function testFile(testPath: string) {
  if (!fs.existsSync(testPath)) return;
  const testSource = fs.readFileSync(testPath, "utf-8");
  const wrapped = wrapTest(testSource);
  const result = await compileAndValidate(wrapped);
  expect(result.instantiateSuccess, `Wasm validation failed: ${result.error}`).toBe(true);
}

describe("Issue 559: coerce arithmetic result to externref before call", () => {
  // Subtraction tests
  it("S11.6.2_A3_T2.2: str-num subtraction", async () => {
    await testFile("/workspace/test262/test/language/expressions/subtraction/S11.6.2_A3_T2.2.js");
  });

  it("S11.6.2_A3_T2.5: bool-str subtraction", async () => {
    await testFile("/workspace/test262/test/language/expressions/subtraction/S11.6.2_A3_T2.5.js");
  });

  // Multiplication tests
  it("S11.5.1_A3_T2.2: str-num multiplication", async () => {
    await testFile("/workspace/test262/test/language/expressions/multiplication/S11.5.1_A3_T2.2.js");
  });

  it("S11.5.1_A3_T2.5: bool-str multiplication", async () => {
    await testFile("/workspace/test262/test/language/expressions/multiplication/S11.5.1_A3_T2.5.js");
  });

  // Division tests
  it("S11.5.2_A3_T2.2: str-num division", async () => {
    await testFile("/workspace/test262/test/language/expressions/division/S11.5.2_A3_T2.2.js");
  });

  it("S11.5.2_A3_T2.5: bool-str division", async () => {
    await testFile("/workspace/test262/test/language/expressions/division/S11.5.2_A3_T2.5.js");
  });

  // Modulus tests
  it("S11.5.3_A3_T2.2: str-num modulus", async () => {
    await testFile("/workspace/test262/test/language/expressions/modulus/S11.5.3_A3_T2.2.js");
  });

  it("S11.5.3_A3_T2.5: bool-str modulus", async () => {
    await testFile("/workspace/test262/test/language/expressions/modulus/S11.5.3_A3_T2.5.js");
  });

  // Addition tests
  it("S11.6.1_A3.2_T2.3: addition test", async () => {
    const testPath = "/workspace/test262/test/language/expressions/addition/S11.6.1_A3.2_T2.3.js";
    if (!fs.existsSync(testPath)) return;
    await testFile(testPath);
  });

  // Minimal reproducer: new Number in string arithmetic context
  it("str * new Number in string concat", async () => {
    const result = await compileAndValidate(wrapTest(`/*---
info: test
es5id: test
description: test
---*/
if ("1" * new Number(1) !== 1) {
  throw new Test262Error('#5: Actual: ' + ("1" * new Number(1)));
}
`));
    expect(result.instantiateSuccess, `Wasm validation failed: ${result.error}`).toBe(true);
  });
});
