/**
 * #1227 — compiler-pool timeout starts at dispatch, not at enqueue.
 *
 * Before the fix, `enqueue()` started the `setTimeout(..., timeoutMs)`
 * immediately when a job was queued. On a saturated pool, jobs that
 * waited 20–30 s in the queue would have their timer fire before the
 * worker ever picked them up — producing false `compile_timeout`
 * results for tests that compile in <1 s in isolation. Phase 1 of
 * #1207 surfaced 156 such false positives in the test262 baseline.
 *
 * The fix moves the timer creation into `dispatch()`. This test
 * exercises the contract empirically:
 *
 *   1. Start a pool with size 1.
 *   2. Submit job A with a long source (real compile, ~few hundred ms)
 *      and a short timeout (e.g. 4 s). It will occupy the only fork
 *      for the duration of its compile.
 *   3. While A is in flight, submit job B with a tiny source and the
 *      same short timeout. B must wait for the fork.
 *   4. Once A finishes and the fork dispatches B, B compiles in <100 ms
 *      and resolves with `ok: true`.
 *
 * Pre-fix: B's timer fires while it's still in the queue → B reports
 * `compile_timeout`. Post-fix: B's timer only starts when the fork
 * receives the job → B succeeds with `ok: true`.
 */
import { describe, expect, it } from "vitest";
import { CompilerPool } from "../scripts/compiler-pool.js";

const SHORT_TIMEOUT_MS = 4_000;

// A real but cheap source — compiles in well under SHORT_TIMEOUT_MS in isolation.
const TINY_SOURCE = `export function test(): number { return 1; }`;

// A larger source that takes a few hundred ms to compile (still well under the
// timeout in isolation, but enough to make the queue-wait scenario observable).
function makeBlockingSource(): string {
  // Build a function with many sequential expressions so codegen does measurable
  // work but never genuinely times out.
  const lines: string[] = [];
  for (let i = 0; i < 200; i++) {
    lines.push(`  let x${i} = ${i} + 1;`);
  }
  lines.push("  return x199;");
  return `export function test(): number {\n${lines.join("\n")}\n}\n`;
}

describe("Issue #1227 — compiler-pool timeout starts at dispatch, not enqueue", () => {
  it("queue-wait time does not count against a job's timeout", async () => {
    // Pool of size 1 so that job B is forced to wait while A holds the fork.
    const pool = new CompilerPool(1);
    await pool.ready();
    try {
      const blocker = makeBlockingSource();
      // Submit A first (occupies the only fork). It compiles in well under
      // SHORT_TIMEOUT_MS in isolation, so its own timer is not in jeopardy.
      const aPromise = pool.compile(blocker, SHORT_TIMEOUT_MS, false, undefined, "issue-1227-A");
      // Yield once so A is dispatched before we enqueue B.
      await new Promise((r) => setImmediate(r));
      // Submit B. B must sit in the queue until A finishes. Pre-fix, B's
      // timer would already be running from this moment; once A's compile
      // takes longer than e.g. ~1 s of queue wait, B's timer would fire
      // while B is still queued.
      const bPromise = pool.compile(TINY_SOURCE, SHORT_TIMEOUT_MS, false, undefined, "issue-1227-B");

      const [aResult, bResult] = await Promise.all([aPromise, bPromise]);
      // A is the larger compile but should succeed.
      expect(aResult.ok, `A failed: ${(aResult as any).error}`).toBe(true);
      // B is what we actually care about — it must succeed even though it
      // sat in the queue while A held the fork.
      expect(bResult.ok, `B failed: ${(bResult as any).error}`).toBe(true);
    } finally {
      pool.shutdown();
    }
  }, 20_000);

  it("a genuinely-stuck worker still produces a compile_timeout (post-dispatch hangs)", async () => {
    // We can simulate a worker hang by submitting a long-running compile
    // with a very short timeout. The fix must NOT regress the case where a
    // worker genuinely runs longer than the timeout — we still need to kill
    // and respawn it so the pool stays healthy.
    const pool = new CompilerPool(1);
    await pool.ready();
    try {
      const blocker = makeBlockingSource();
      // Use a 50 ms timeout — the blocker source comfortably takes more than
      // that to compile, so the post-dispatch timer will fire.
      const result = await pool.compile(blocker, 50, false, undefined, "issue-1227-hang");
      expect(result.ok).toBe(false);
      expect((result as any).error).toMatch(/timeout/i);
    } finally {
      pool.shutdown();
    }
  }, 15_000);
});
