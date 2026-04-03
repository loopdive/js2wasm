import { defineConfig } from "vite";
import { resolve } from "node:path";
import { test262Plugin } from "./vite-plugin-test262.js";
import { dashboardPlugin } from "./vite-plugin-dashboard.js";

export default defineConfig({
  root: resolve(import.meta.dirname, ".."),
  appType: "mpa",
  base: "./",
  publicDir: "public",
  plugins: [
    test262Plugin(),
    dashboardPlugin(),
  ],
  optimizeDeps: {
    // Pre-bundle heavy deps so Vite doesn't transform them on each page load.
    // compiler-bundle.mjs (3.2MB) and runtime-bundle.mjs (3.2MB) cause OOM without this.
    include: [
      "typescript",
      "monaco-editor/esm/vs/editor/editor.api",
    ],
    exclude: ["binaryen"],
    esbuildOptions: {
      target: "esnext",
    },
  },
  resolve: {
    alias: {
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
