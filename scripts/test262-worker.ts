/**
 * Batch worker for test262 — receives a batch of test files, runs them all,
 * sends results back one at a time. Stays alive for multiple batches.
 */
import { runTest262File } from "../tests/test262-runner.js";

process.on('message', async (msg: any) => {
  if (msg.batch) {
    // Process a batch of tests sequentially
    for (const job of msg.batch as Array<{ filePath: string; category: string; relPath: string }>) {
      try {
        const result = await runTest262File(job.filePath, job.category);
        process.send!({
          file: result.file, category: result.category, status: result.status,
          ...(result.error ? { error: result.error.substring(0, 300) } : {}),
          ...(result.reason ? { reason: result.reason } : {}),
          ...(result.timing ? { timing: result.timing } : {}),
        });
      } catch (e: any) {
        process.send!({
          file: job.relPath, category: job.category, status: "compile_error",
          error: (e?.message ?? String(e)).substring(0, 300),
        });
      }
    }
    // Signal batch complete
    process.send!({ batchDone: true });
  } else {
    // Legacy single-test mode
    const job = msg as { filePath: string; category: string; relPath: string };
    try {
      const result = await runTest262File(job.filePath, job.category);
      process.send!({
        file: result.file, category: result.category, status: result.status,
        ...(result.error ? { error: result.error.substring(0, 300) } : {}),
        ...(result.reason ? { reason: result.reason } : {}),
        ...(result.timing ? { timing: result.timing } : {}),
      });
    } catch (e: any) {
      process.send!({
        file: job.relPath, category: job.category, status: "compile_error",
        error: (e?.message ?? String(e)).substring(0, 300),
      });
    }
  }
});

process.send!({ ready: true });
