import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    pool: 'forks',
    poolOptions: {
      forks: {
        // 2 forks × 2 compiler threads each — balances parallelism vs memory
        // Each fork compiles + executes its share; forks die and free memory.
        maxForks: parseInt(process.env.TEST262_WORKERS || '2', 10),
        execArgv: ['--max-old-space-size=2048'],
      },
    },
    testTimeout: 10000, // 10s per test — prevents infinite compilation loops from blocking the run
  },
});
