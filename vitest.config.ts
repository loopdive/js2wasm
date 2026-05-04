import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    pool: "forks",
    poolOptions: {
      forks: {
        // Each test file gets its own fork process — when it finishes, the OS
        // reclaims all memory (same strategy as the test262 chunk runner).
        // maxForks=1 ensures only one fork at a time (no parallel OOM).
        singleFork: false,
        maxForks: 1,
        minForks: 0,
        execArgv: ["--max-old-space-size=512", "--expose-gc"],
      },
    },
    // Lets describe.concurrent tests run up to 32 at once — CompilerPool limits
    // actual concurrent compilations to POOL_SIZE (availableParallelism - 1).
    // Without this, vitest runs it() blocks within a describe() sequentially,
    // leaving pool workers idle and stretching test262 runs to 150+ minutes.
    maxConcurrency: 32,
    // 35s — must sit above the compiler's internal 30s timeout so that
    // `compile_timeout` status can be recorded before vitest force-kills the
    // test. With describe.concurrent (see PR #14), a 10s ceiling flipped
    // tests from pass→compile_timeout under CPU contention (issue #1171).
    testTimeout: 35000,
  },
});
