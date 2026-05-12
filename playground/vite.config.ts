import { defineConfig, type Plugin } from "vite";
import { resolve } from "node:path";
import { copyFileSync } from "node:fs";
import { test262Plugin } from "./vite-plugin-test262.js";
import { compilerBundlePlugin } from "./vite-plugin-compiler-bundle.js";
import { adrPlugin } from "./vite-plugin-adr.js";

const projectRoot = resolve(import.meta.dirname, "..");

function frameNavSyncPlugin(): Plugin {
  let outDir = resolve(projectRoot, "dist/playground");
  return {
    name: "frame-nav-sync",
    apply: "build",
    configResolved(config) {
      outDir = resolve(projectRoot, config.build.outDir);
    },
    closeBundle() {
      copyFileSync(resolve(projectRoot, "frame-nav-sync.js"), resolve(outDir, "frame-nav-sync.js"));
    },
  };
}

export default defineConfig(async () => {
  const plugins = [compilerBundlePlugin(), test262Plugin(), adrPlugin(), frameNavSyncPlugin()];

  return {
    root: projectRoot,
    appType: "mpa",
    base: "./",
    publicDir: "public",
    plugins,
    optimizeDeps: {
      // Pre-bundle heavy deps so Vite doesn't transform them on each page load.
      // compiler-bundle.mjs (3.2MB) and runtime-bundle.mjs (3.2MB) cause OOM without this.
      include: ["typescript", "monaco-editor/esm/vs/editor/editor.api"],
      esbuildOptions: {
        target: "esnext",
      },
    },
    resolve: {
      alias: {
        path: resolve(import.meta.dirname, "stubs/path-shim.js"),
        "node:path": resolve(import.meta.dirname, "stubs/path-shim.js"),
        "node:fs": resolve(import.meta.dirname, "stubs/node-fs-stub.js"),
        "node:child_process": resolve(import.meta.dirname, "stubs/node-stub.js"),
        "node:os": resolve(import.meta.dirname, "stubs/node-stub.js"),
        "node:module": resolve(import.meta.dirname, "stubs/node-module-stub.js"),
      },
    },
    server: {
      fs: {
        allow: ["."],
      },
      watch: {
        // Exclude large local data, dependencies, and build artifacts.
        // Without this, Vite watches the entire project root including full repo
        // copies and generated test262 logs. Each file change triggers transforms
        // that can accumulate and OOM long-running dev servers.
        ignored: [
          "**/test262/**",
          "**/node_modules/**",
          "**/.test262-cache/**",
          "**/dist/pages/**",
          "**/dist/playground/**",
          "**/benchmarks/results/test262-results-*.jsonl",
        ],
      },
    },
    build: {
      outDir: "dist/playground",
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
  };
});
