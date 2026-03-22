import { defineConfig } from "vite";
import { test262Plugin } from "./vite-plugin-test262.js";

export default defineConfig({
  base: "./",
  plugins: [test262Plugin()],
  resolve: {
    alias: {
      // Stub out node-only modules for browser compatibility
      "node:child_process": "./empty-module.ts",
      "node:os": "./empty-module.ts",
    },
  },
  server: {
    fs: {
      // Allow serving files from project root (benchmarks, test262)
      allow: [".."],
    },
  },
  build: {
    outDir: "../playground-dist",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/monaco-editor")) return "monaco";
          if (id.includes("node_modules/typescript")) return "typescript";
        },
      },
    },
  },
});
