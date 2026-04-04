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
    testTimeout: 10000, // 10s per test — prevents infinite compilation loops from blocking the run
  },
});
