import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    pool: 'forks',
    poolOptions: {
      forks: {
        maxForks: parseInt(process.env.TEST262_WORKERS || '3', 10),
        execArgv: ['--max-old-space-size=4096'],
      },
    },
    testTimeout: 10000, // 10s per test — prevents infinite compilation loops from blocking the run
  },
});
