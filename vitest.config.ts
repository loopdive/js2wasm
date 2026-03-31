import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    pool: 'forks',
    poolOptions: {
      forks: {
        // 8 chunk files, but limit forks to avoid OOM (16GB container)
        // 4 forks × 2GB heap = 8GB, leaves ~8GB for system + agents
        maxForks: parseInt(process.env.TEST262_WORKERS || '4', 10),
        execArgv: ['--max-old-space-size=2048'],
      },
    },
    testTimeout: 10000, // 10s per test — prevents infinite compilation loops from blocking the run
  },
});
