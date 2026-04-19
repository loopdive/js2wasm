import { builtinModules } from "node:module";
import { defineConfig } from "vite";
import dts from "vite-plugin-dts";

// Library build config for npm publishing as @loopdive/js2.
// Unlike vite.config.ts (which targets browsers for the playground),
// this targets modern Node so top-level await, dynamic imports, and
// bare `node:*` / `fs` / `path` imports are preserved as externals.
const nodeBuiltins = [...builtinModules, ...builtinModules.map((m) => `node:${m}`)];

export default defineConfig({
  plugins: [
    dts({
      entryRoot: "src",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      rollupTypes: false,
    }),
  ],
  publicDir: false,
  build: {
    target: "node20",
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    minify: false,
    lib: {
      entry: {
        index: "src/index.ts",
        cli: "src/cli.ts",
        runtime: "src/runtime.ts",
        optimize: "src/optimize.ts",
      },
      formats: ["es"],
      fileName: (_format, entry) => `${entry}.js`,
    },
    rollupOptions: {
      external: ["typescript", "binaryen", ...nodeBuiltins],
      output: {
        preserveModules: false,
        inlineDynamicImports: false,
      },
    },
  },
});
