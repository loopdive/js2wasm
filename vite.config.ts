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
    target: "esnext",
    lib: {
      entry: {
        index: "src/index.ts",
        cli: "src/cli.ts",
      },
      formats: ["es"],
    },
    rollupOptions: {
      external: [
        "typescript",
        "binaryen",
        "path",
        "fs",
        "url",
        "os",
        "child_process",
        "node:fs",
        "node:path",
        "node:process",
        "node:module",
        "node:url",
        "node:os",
        "node:child_process",
      ],
    },
  },
});
