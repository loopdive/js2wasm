/**
 * Vite plugin to serve the pre-built compiler bundle without going through
 * Vite's transform pipeline. This prevents the 9GB+ OOM caused by
 * import-analysis parsing the entire compiler source tree (#924).
 *
 * In dev mode:
 *   - Intercepts imports to `../src/index.js`, `../src/optimize.js`, `../src/runtime.js`
 *     from playground files and redirects them to a virtual shim module
 *   - The shim uses dynamic import(@vite-ignore) to load the pre-built bundle
 *     from `/@compiler-bundle.mjs`, which is served via middleware
 *   - Vite never parses the 2.3MB bundle — the browser loads it natively
 *
 * In production build:
 *   - Plugin is inactive (apply: "serve") — rollup handles source imports directly
 */
import type { Plugin } from "vite";
import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve } from "node:path";

const SHIM_ID = "\0compiler-bundle-shim";

// Imports from src/ that should be redirected to the pre-built bundle.
const REDIRECTED_SOURCES = new Set([
  "../src/index.js",
  "../src/optimize.js",
  "../src/runtime.js",
]);

export function compilerBundlePlugin(): Plugin {
  let bundleCache: string | null = null;

  return {
    name: "compiler-bundle",
    enforce: "pre", // run before Vite's internal resolver
    apply: "serve", // dev mode only

    resolveId(source, importer) {
      // Only intercept imports from playground files
      if (!importer || !importer.includes("/playground/")) return;
      if (REDIRECTED_SOURCES.has(source)) {
        return SHIM_ID;
      }
    },

    load(id) {
      if (id !== SHIM_ID) return;

      // Return a tiny shim that dynamically imports the pre-built bundle.
      // The URL is constructed via expression so import-analysis won't
      // try to resolve/transform the 2.3MB bundle (which causes OOM).
      // Top-level await ensures exports are available synchronously to importers.
      return `
const __bundleUrl = "/@compiler-" + "bundle.mjs";
const __mod = await import(/* @vite-ignore */ __bundleUrl);

// Re-export everything the playground uses from src/index.js
export const compile = __mod.compile;
export const compileMulti = __mod.compileMulti;
export const jsString = __mod.jsString;
export const compileToWat = __mod.compileToWat;
export const compileAndInstantiate = __mod.compileAndInstantiate;
export const preloadLibFiles = __mod.preloadLibFiles;

// Re-export from src/optimize.js
export const optimizeBinaryAsync = __mod.optimizeBinaryAsync;

// Re-export from src/runtime.js
export const buildImports = __mod.buildImports;
export const buildStringConstants = __mod.buildStringConstants;
export const instantiateWasm = __mod.instantiateWasm;
`;
    },

    configureServer(server) {
      // Serve the compiler bundle as raw JS, bypassing Vite's transform pipeline.
      server.middlewares.use((req, res, next) => {
        const pathname = req.url?.split("?")[0];
        if (pathname !== "/@compiler-bundle.mjs") return next();

        if (!bundleCache) {
          const bundlePath = resolve(
            import.meta.dirname,
            "../scripts/compiler-bundle.mjs",
          );

          // Build the bundle on demand if it doesn't exist (gitignored artifact)
          if (!existsSync(bundlePath)) {
            const root = resolve(import.meta.dirname, "..");
            console.log("[compiler-bundle] Building compiler bundle...");
            execSync("pnpm run build:compiler-bundle", {
              cwd: root,
              stdio: "inherit",
            });
          }

          let code = readFileSync(bundlePath, "utf-8");

          // Rewrite the 2 bare specifier imports to Vite-resolvable URLs.
          // typescript: Vite transforms the re-export module and resolves
          //   to its pre-bundled version automatically.
          // path: browser shim with resolve/dirname/relative/join/basename.
          code = code.replace(
            /from "typescript"/g,
            'from "/playground/stubs/typescript-reexport.js"',
          );
          code = code.replace(
            /from "path"/g,
            'from "/playground/stubs/path-shim.js"',
          );

          bundleCache = code;
        }

        res.setHeader("Content-Type", "application/javascript; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache");
        res.end(bundleCache);
      });
    },
  };
}
