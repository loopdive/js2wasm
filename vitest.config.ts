import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    pool: 'forks',
    poolOptions: {
      forks: {
        // 1 vitest fork — CompilerPool inside spawns cpus-1 child_process.fork workers
        // Multiple vitest forks would create multiple pools and OOM
        maxForks: 1,
        execArgv: ['--max-old-space-size=4096', '--expose-gc'],
      },
    },
    testTimeout: 10000, // 10s per test — prevents infinite compilation loops from blocking the run
  },
});
