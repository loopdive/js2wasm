import { defineConfig } from "vite";
import { resolve } from "node:path";
import { test262Plugin } from "./vite-plugin-test262.js";
import { dashboardPlugin } from "./vite-plugin-dashboard.js";

export default defineConfig({
  root: resolve(import.meta.dirname, ".."),
  appType: "mpa",
  base: "./",
  publicDir: "public",
  plugins: [test262Plugin(), dashboardPlugin()],
  optimizeDeps: {
    // Pre-bundle the compiler source tree so Vite doesn't transform 15K+ lines on each page load.
    // binaryen is excluded (stubbed via resolve.alias) since it's a native module.
    include: ["typescript", "monaco-editor/esm/vs/editor/editor.api"],
    exclude: ["binaryen"],
    esbuildOptions: {
      target: "esnext",
    },
  },
  resolve: {
    alias: {
      // Stub binaryen for dev server — optimize.ts handles the import failure gracefully
      binaryen: "/workspace/playground/stubs/binaryen.js",
    },
  },
  server: {
    fs: {
      allow: ["."],
    },
  },
  build: {
    outDir: "playground-dist",
    emptyOutDir: true,
    target: "esnext",
    rollupOptions: {
      external: ["binaryen"],
      input: {
        index: resolve(import.meta.dirname, "../index.html"),
        playground: resolve(import.meta.dirname, "index.html"),
      },
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/monaco-editor")) return "monaco";
          if (id.includes("node_modules/typescript")) return "typescript";
        },
      },
    },
  },
});
