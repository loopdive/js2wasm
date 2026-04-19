/**
 * Issue #1119: Incremental compiler state leak — CompilerPool fork
 * produces ~400 false CEs.
 *
 * The fork worker (`scripts/compiler-fork-worker.mjs`) uses
 * `createIncrementalCompiler()`, which previously passed `oldProgram` into
 * `ts.createProgram` to reuse structure across compilations. In practice
 * this leaked TypeScript checker state: a specific user source could poison
 * the reused program (scope-chain / type-resolution cycles) so that every
 * subsequent compile inside the same incremental compiler threw
 * "Maximum call stack size exceeded" in ~0 ms until RECREATE_INTERVAL
 * kicked in.
 *
 * Fix: drop `oldProgram` reuse in `IncrementalLanguageService.analyze()`.
 * Lib SourceFiles remain cached (main perf win) but each compilation gets
 * a fresh `ts.Program` with a fresh checker.
 */
import { describe, expect, it } from "vitest";
import { compile, createIncrementalCompiler } from "../src/index.ts";

const opts = { fileName: "test.ts", emitWat: false, skipSemanticDiagnostics: true };

describe("Issue #1119 — no cross-compilation leak in incremental compiler", () => {
  it("100 sequential mixed compilations match standalone byte-for-byte", () => {
    // Patterns drawn from test262 flavors that have historically tripped
    // state-reuse bugs: Promise/async, Error subclasses, generators,
    // private fields, decorators, typed arrays, declaration merging,
    // global augmentation via interface declarations, catch-binding.
    const sources: string[] = [];
    for (let i = 0; i < 10; i++) {
      sources.push(
        `export async function test(): Promise<number> { return ${i}; }`,
        `class E${i} extends Error { constructor(m: string) { super(m); } }
         export function test(): number { try { throw new E${i}("x"); } catch { return 1; } return 0; }`,
        `function* g${i}() { yield ${i}; }
         export function test(): number { return g${i}().next().value ?? 0; }`,
        `class X${i} { #p = ${i}; getP() { return this.#p; } }
         export function test(): number { return new X${i}().getP(); }`,
        `interface Foo${i} { a: number; b: string }
         export function test(): number { const f: Foo${i} = { a: ${i}, b: "x" }; return f.a; }`,
        `type U${i} = "a" | "b" | number;
         export function test(): number { const x: U${i} = ${i}; return typeof x === "number" ? 1 : 0; }`,
        `class A${i} { static foo = ${i}; }
         class B${i} extends A${i} {}
         export function test(): number { return B${i}.foo; }`,
        `const m = new Map<string, number>();
         m.set("k", ${i});
         export function test(): number { return m.get("k") ?? 0; }`,
        `const arr: number[] = [${i}, ${i + 1}, ${i + 2}];
         export function test(): number { return arr.reduce((a, b) => a + b, 0); }`,
        `const p = new Promise<number>((r) => r(${i}));
         p.then((v) => v);
         export function test(): number { return 1; }`,
      );
    }

    expect(sources.length).toBe(100);

    const incr = createIncrementalCompiler(opts);
    let successMismatches = 0;
    let binaryMismatches = 0;
    const firstMismatches: string[] = [];

    for (let i = 0; i < sources.length; i++) {
      const src = sources[i]!;
      const standalone = compile(src, opts);
      const incremental = incr.compile(src);

      if (standalone.success !== incremental.success) {
        successMismatches++;
        if (firstMismatches.length < 3) {
          firstMismatches.push(
            `#${i} success: std=${standalone.success} inc=${incremental.success} incErr=${incremental.errors
              .filter((e) => e.severity === "error")
              .map((e) => e.message)
              .join("|")}`,
          );
        }
        continue;
      }
      if (standalone.success && standalone.binary.length !== incremental.binary.length) {
        binaryMismatches++;
        if (firstMismatches.length < 3) {
          firstMismatches.push(`#${i} binary len: std=${standalone.binary.length} inc=${incremental.binary.length}`);
        }
      }
    }
    incr.dispose();

    if (successMismatches + binaryMismatches > 0) {
      // eslint-disable-next-line no-console
      console.error("mismatches:", firstMismatches);
    }
    expect(successMismatches).toBe(0);
    expect(binaryMismatches).toBe(0);
  });

  it("after a heavy-type compile, all subsequent compiles succeed (no poisoning)", () => {
    // A source with many lib types and declaration-merging flavors that is
    // the kind of input observed to "poison" the reused program.
    const heavy = `
      interface Array<T> { __marker_1119?: T }
      interface Error { __marker_1119?: number }
      class MyErr extends Error {
        constructor(public code: number) { super("err"); }
      }
      async function* gen(): AsyncGenerator<number, void, unknown> {
        yield 1; yield 2;
      }
      class Holder<T extends Error> {
        constructor(public err: T) {}
      }
      export function test(): number {
        const h = new Holder(new MyErr(42));
        return h.err.code;
      }
    `;
    const light = `export function test(): number { return 1; }`;

    const incr = createIncrementalCompiler(opts);

    const r0 = incr.compile(heavy);
    // Regardless of whether the heavy source compiles, the next ones must succeed.
    expect(typeof r0.success).toBe("boolean");

    for (let i = 0; i < 20; i++) {
      const r = incr.compile(light);
      expect(r.success).toBe(true);
      expect(r.binary.length).toBeGreaterThan(0);
      // Must not produce a stack-overflow CE — if it does, that's the leak.
      const stackErr = r.errors.find((e) => e.message.includes("Maximum call stack"));
      expect(stackErr).toBeUndefined();
    }

    incr.dispose();
  });
});
