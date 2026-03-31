import { defineConfig } from 'vitest/config';
import os from 'os';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    pool: 'forks',
    poolOptions: {
      forks: {
        // Default: 3 forks (each runs 4 compiler worker threads = 12 parallel compilations)
        // Override with TEST262_WORKERS env var
        maxForks: parseInt(process.env.TEST262_WORKERS || '3', 10),
        execArgv: ['--max-old-space-size=4096'],
      },
    },
    testTimeout: 10000, // 10s per test — prevents infinite compilation loops from blocking the run
  },
});
