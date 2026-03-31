import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    pool: 'forks',
    poolOptions: {
      forks: {
        // 8 chunk files = up to 8 forks for parallel test262 execution
        maxForks: parseInt(process.env.TEST262_WORKERS || '8', 10),
        execArgv: ['--max-old-space-size=2048'],
      },
    },
    testTimeout: 10000, // 10s per test — prevents infinite compilation loops from blocking the run
  },
});
