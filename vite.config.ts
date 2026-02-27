import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

export default defineConfig({
  plugins: [dts()],
  build: {
    lib: {
      entry: {
        index: 'src/index.ts',
        cli: 'src/cli.ts',
      },
      formats: ['es'],
    },
    rollupOptions: {
      external: ['typescript', 'node:fs', 'node:path', 'node:process'],
    },
  },
});
