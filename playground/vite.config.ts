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
    esbuildOptions: {
      target: "esnext",
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
