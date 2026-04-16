import { defineConfig } from "vite";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { test262Plugin } from "./vite-plugin-test262.js";
import { compilerBundlePlugin } from "./vite-plugin-compiler-bundle.js";

const projectRoot = resolve(import.meta.dirname, "..");
const dashboardPluginPath = resolve(import.meta.dirname, "vite-plugin-dashboard.ts");
const hasDashboardData =
  existsSync(resolve(projectRoot, "dashboard", "index.html")) &&
  existsSync(resolve(projectRoot, "plan", "issues"));

export default defineConfig(async () => {
  const plugins = [compilerBundlePlugin(), test262Plugin()];
  if (hasDashboardData && existsSync(dashboardPluginPath)) {
    const { dashboardPlugin } = await import(pathToFileURL(dashboardPluginPath).href);
    plugins.push(dashboardPlugin());
  }

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
