import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    pool: 'forks',
    poolOptions: {
      forks: { maxForks: parseInt(process.env.TEST262_WORKERS || '3', 10) },
    },
  },
});
