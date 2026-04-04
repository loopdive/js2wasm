import { defineConfig } from "vite";
import dts from "vite-plugin-dts";

export default defineConfig({
  plugins: [dts()],
  // Dev server: serve the landing page (index.html) as static HTML.
  // Exclude compiler source from dep scanning — it pulls in binaryen/typescript
  // and makes page loads take 30+ seconds.
  optimizeDeps: {
    exclude: ["binaryen", "typescript"],
  },
  server: {
    fs: {
      // Allow serving files from the whole workspace (benchmarks/, dashboard/, etc.)
      allow: ["."],
    },
  },
  build: {
    lib: {
      entry: {
        index: "src/index.ts",
        cli: "src/cli.ts",
      },
      formats: ["es"],
    },
    rollupOptions: {
      external: ["typescript", "node:fs", "node:path", "node:process", "binaryen"],
    },
  },
});
