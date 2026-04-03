import { defineConfig } from "vite";
import { resolve } from "node:path";
import { test262Plugin } from "./vite-plugin-test262.js";
import { dashboardPlugin } from "./vite-plugin-dashboard.js";
import { compilerBundlePlugin } from "./vite-plugin-compiler-bundle.js";

export default defineConfig({
  root: resolve(import.meta.dirname, ".."),
  appType: "mpa",
  base: "./",
  publicDir: "public",
  plugins: [
    compilerBundlePlugin(),
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
    watch: {
      // Exclude agent worktrees, test262, node_modules, and build artifacts.
      // Without this, Vite watches the entire project root including full repo
      // copies in .claude/worktrees/ — each file change triggers transforms
      // that accumulate and OOM after ~4 minutes.
      ignored: [
        "**/.claude/worktrees/**",
        "**/test262/**",
        "**/node_modules/**",
        "**/.test262-cache/**",
        "**/pages-dist/**",
        "**/playground-dist/**",
        "**/benchmarks/results/test262-results-*.jsonl",
      ],
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
