import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    pool: 'forks',
    poolOptions: {
      forks: {
        // 1 fork (vitest distributes by file, we have 1 test file with 48K tests)
        // The fork internally runs 4 compiler worker threads for pipelining
        maxForks: parseInt(process.env.TEST262_WORKERS || '1', 10),
        execArgv: ['--max-old-space-size=4096'],
      },
    },
    testTimeout: 10000,
  },
});
