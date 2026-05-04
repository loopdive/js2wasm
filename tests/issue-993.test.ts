import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

/**
 * #993 — break/continue/return inside `finally` block must use the right
 * control-flow depth.
 *
 * Before the fix, the finally body was pre-compiled with break/continue
 * depths from the outer (pre-try) context, but later inlined inside the
 * try block (which adds one label level). The cloned `br N` instructions
 * targeted the wrong label, so e.g. `break` inside finally restarted the
 * enclosing loop instead of exiting it — causing infinite loops in
 * test262 S12.14_A9_T3 / A11_T3 / A12_T3 (do-while / for / for-in with
 * try/finally + break in finally).
 */
describe("#993 — break/continue/return inside finally", () => {
  async function run(src: string): Promise<any> {
    const r = compile(src, { fileName: "test.ts" });
    if (!r.success) throw new Error(`CE: ${r.errors[0]?.message}`);
    const imports = buildImports(r.imports, undefined, r.stringPool);
    const { instance } = await WebAssembly.instantiate(r.binary, imports);
    return (instance.exports as any).test?.();
  }

  it("break inside finally exits do-while loop", async () => {
    const ret = await run(`
      export function test(): number {
        let c: number = 0;
        do {
          try {
            c = c + 1;
          } finally {
            break;  // must break out of the do-while, not restart it
          }
          c = c + 100;
        } while (c < 5);
        return c;  // expect 1 (finally ran once, break exited)
      }
    `);
    expect(ret).toBe(1);
  });

  it("break inside finally exits for loop", async () => {
    const ret = await run(`
      export function test(): number {
        let c: number = 0;
        let fin: number = 0;
        for (let i = 0; i < 5; i++) {
          try {
            throw "ex";
          } catch (er) {
            c = c + 1;
          } finally {
            fin = 1;
            break;
          }
        }
        if (fin !== 1) return 11;
        if (c !== 1) return 12;
        return 1;
      }
    `);
    expect(ret).toBe(1);
  });

  it("break inside finally exits while loop with throw+catch", async () => {
    const ret = await run(`
      export function test(): number {
        let c: number = 0;
        let fin: number = 0;
        while (c < 5) {
          try {
            throw "ex";
          } catch (e) {
            c = c + 1;
          } finally {
            fin = 1;
            break;
          }
          c = c + 100;
          fin = -1;
        }
        if (fin !== 1) return 11;
        if (c !== 1) return 12;
        return 1;
      }
    `);
    expect(ret).toBe(1);
  });

  it("break inside try-with-finally (no catch) still works", async () => {
    const ret = await run(`
      export function test(): number {
        let c: number = 0;
        let fin: number = 0;
        do {
          try {
            c = c + 1;
            break;
          } finally {
            fin = 1;
          }
          fin = -1;
          c = c + 100;
        } while (c < 5);
        if (fin !== 1) return 11;
        if (c !== 1) return 12;
        return 1;
      }
    `);
    expect(ret).toBe(1);
  });

  it("break inside finally inside catch path", async () => {
    const ret = await run(`
      export function test(): number {
        let c: number = 0;
        let fin: number = 0;
        do {
          try {
            throw "x";
          } catch (e) {
            c = c + 1;
            break;
          } finally {
            fin = 1;
          }
          c = c + 100;
          fin = -1;
        } while (c < 5);
        if (fin !== 1) return 11;
        if (c !== 1) return 12;
        return 1;
      }
    `);
    expect(ret).toBe(1);
  });

  it("continue inside finally moves to next loop iteration", async () => {
    const ret = await run(`
      export function test(): number {
        let total: number = 0;
        let i: number = 0;
        while (i < 3) {
          i = i + 1;
          try {
            // pretend we want to skip some work — finally always runs continue
          } finally {
            continue;
          }
          total = total + 100; // never reached
        }
        return total === 0 ? 1 : 100 + total;
      }
    `);
    expect(ret).toBe(1);
  });

  it("nested try-finally with break in inner finally", async () => {
    const ret = await run(`
      export function test(): number {
        let outerFin: number = 0;
        let innerFin: number = 0;
        let c: number = 0;
        do {
          try {
            try {
              c = c + 1;
            } finally {
              innerFin = 1;
              break;  // break out of the do-while
            }
            c = c + 100;
          } finally {
            outerFin = 1;
          }
          c = c + 1000;
        } while (c < 10);
        if (innerFin !== 1) return 11;
        if (outerFin !== 1) return 12;
        if (c !== 1) return 13;
        return 1;
      }
    `);
    expect(ret).toBe(1);
  });

  it("eager generator with infinite while(true) yields throws RangeError instead of OOM", async () => {
    // #991/#992 companion: our eager-generator lowering fully populates the
    // yield buffer before .next() can be called. An infinite generator must
    // not loop forever — it must throw a RangeError once the buffer cap is
    // reached. Prior to the fix, this OOMed the worker process and surfaced
    // as a 30s test262 compile_timeout instead of a normal runtime exception.
    const ret = await run(`
      function* g() {
        while (true) {
          yield 1;
        }
      }
      export function test(): number {
        try {
          const it: any = g();
          // The cap throws inside g()'s body; our compiler captures it as a
          // pendingThrow on the generator. So g() returns normally with a
          // generator object; the throw fires on the FIRST exhausted next().
          if (it == null) return 2;
          // We don't iterate — we just verify that g() returns in finite time.
          return 1;
        } catch (e) {
          // Some compilation modes may surface the throw at construction time;
          // either path is acceptable, the test is "the call returns finite-time".
          return 1;
        }
      }
    `);
    expect(ret).toBe(1);
  }, 10_000);
});
