// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1299 — Virtual dispatch through abstract-base-typed dict values
// resolves to the FIRST stored subclass's method for ALL stored values.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

interface RunResult {
  exports: Record<string, Function>;
}

async function run(src: string): Promise<RunResult> {
  const result = compile(src, { fileName: "test.ts" });
  if (!result.success) {
    throw new Error(`compile failed:\n${result.errors.map((e) => `  L${e.line}:${e.column} ${e.message}`).join("\n")}`);
  }
  const importResult = buildImports(result.imports as never, undefined, result.stringPool);
  const inst = await WebAssembly.instantiate(result.binary, importResult as never);
  if (typeof (importResult as { setExports?: Function }).setExports === "function") {
    (importResult as { setExports: Function }).setExports(inst.instance.exports);
  }
  return { exports: inst.instance.exports as Record<string, Function> };
}

describe("#1299 virtual dispatch through abstract-base-typed dict values", () => {
  /**
   * Repro from the issue file. Two subclasses of an abstract base
   * stored in a dict typed by the base. Calling `id()` through the dict
   * lookup must resolve to the runtime class's method.
   */
  it("dict[k].id() dispatches to the runtime subclass's method", async () => {
    const { exports } = await run(`
      abstract class Base { abstract id(): number; }
      class A extends Base { id(): number { return 1; } }
      class B extends Base { id(): number { return 2; } }

      export function test(): number {
        const dict: { [k: string]: Base } = {};
        dict["a"] = new A();
        dict["b"] = new B();
        return dict["a"].id() * 1000 + dict["b"].id();  // expected 1002
      }
    `);
    expect(exports.test!()).toBe(1002);
  });

  /**
   * Plain-local baseline — no dict involved. This already works on
   * main. Guard against regressing the simpler virtual dispatch path
   * while fixing the dict path.
   */
  it("baseline: plain-local Base = new A() | new B() dispatches correctly", async () => {
    const { exports } = await run(`
      abstract class Base { abstract id(): number; }
      class A extends Base { id(): number { return 1; } }
      class B extends Base { id(): number { return 2; } }

      export function test(): number {
        const a: Base = new A();
        const b: Base = new B();
        return a.id() * 1000 + b.id();
      }
    `);
    expect(exports.test!()).toBe(1002);
  });

  /**
   * Concrete-base + override — non-abstract base with own implementation
   * overridden by a subclass. Stored in dict, called through dict.
   * Both base instance and override instance must dispatch correctly.
   */
  it("concrete base + override dispatches through dict", async () => {
    const { exports } = await run(`
      class Base { name(): string { return "base"; } }
      class Sub extends Base { name(): string { return "sub"; } }

      export function test(): string {
        const dict: { [k: string]: Base } = {};
        dict["a"] = new Base();
        dict["b"] = new Sub();
        return dict["a"].name() + ":" + dict["b"].name();  // expected "base:sub"
      }
    `);
    expect(exports.test!()).toBe("base:sub");
  });

  /**
   * Three subclasses to verify the dispatch isn't just a 2-bucket fluke.
   * Each registered subclass with a distinct id; reading from each key
   * must return that subclass's id.
   */
  it("three subclasses dispatched through dict each return their own id", async () => {
    const { exports } = await run(`
      abstract class Base { abstract id(): number; }
      class X extends Base { id(): number { return 7; } }
      class Y extends Base { id(): number { return 11; } }
      class Z extends Base { id(): number { return 13; } }

      export function test(): number {
        const dict: { [k: string]: Base } = {};
        dict["x"] = new X();
        dict["y"] = new Y();
        dict["z"] = new Z();
        return dict["x"].id() + dict["y"].id() * 100 + dict["z"].id() * 10000;
        // expected 7 + 1100 + 130000 = 131107
      }
    `);
    expect(exports.test!()).toBe(131107);
  });
});
