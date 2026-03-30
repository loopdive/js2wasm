import { defineConfig } from "vite";
import { test262Plugin } from "./vite-plugin-test262.js";
import { dashboardPlugin } from "./vite-plugin-dashboard.js";

export default defineConfig({
  base: "./",
  plugins: [test262Plugin(), dashboardPlugin()],
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
