/**
 * Batch worker for test262 — receives a batch of test files, runs them all,
 * sends results back one at a time. Stays alive for multiple batches.
 */
import { runTest262File } from "../tests/test262-runner.js";

/** Per-test timeout (ms) — kills tests that trigger infinite loops in compiler */
const PER_TEST_TIMEOUT_MS = 15_000;

/** Run a single test with a timeout. Rejects if the test takes too long. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timeout: test exceeded ${ms / 1000}s limit`));
    }, ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

process.on('message', async (msg: any) => {
  if (msg.batch) {
    // Process a batch of tests sequentially
    for (const job of msg.batch as Array<{ filePath: string; category: string; relPath: string }>) {
      try {
        const result = await withTimeout(
          runTest262File(job.filePath, job.category),
          PER_TEST_TIMEOUT_MS,
          job.relPath,
        );
        process.send!({
          file: result.file, category: result.category, status: result.status,
          ...(result.error ? { error: result.error.substring(0, 300) } : {}),
          ...(result.reason ? { reason: result.reason } : {}),
          ...(result.timing ? { timing: result.timing } : {}),
        });
      } catch (e: any) {
        const errMsg = (e?.message ?? String(e)).substring(0, 300);
        const isTimeout = errMsg.includes("timeout:");
        process.send!({
          file: job.relPath, category: job.category,
          status: isTimeout ? "fail" : "compile_error",
          error: errMsg,
        });
      }
    }
    // Signal batch complete
    process.send!({ batchDone: true });
  } else {
    // Legacy single-test mode
    const job = msg as { filePath: string; category: string; relPath: string };
    try {
      const result = await withTimeout(
        runTest262File(job.filePath, job.category),
        PER_TEST_TIMEOUT_MS,
        job.relPath,
      );
      process.send!({
        file: result.file, category: result.category, status: result.status,
        ...(result.error ? { error: result.error.substring(0, 300) } : {}),
        ...(result.reason ? { reason: result.reason } : {}),
        ...(result.timing ? { timing: result.timing } : {}),
      });
    } catch (e: any) {
      const errMsg = (e?.message ?? String(e)).substring(0, 300);
      const isTimeout = errMsg.includes("timeout:");
      process.send!({
        file: job.relPath, category: job.category,
        status: isTimeout ? "fail" : "compile_error",
        error: errMsg,
      });
    }
  }
});

process.send!({ ready: true });
