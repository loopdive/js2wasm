/**
 * Browser-compatible loader for TypeScript lib .d.ts files.
 *
 * Uses Vite's import.meta.glob with the ?raw suffix to bundle all
 * TypeScript lib files at build time. Call loadLibFiles() before
 * using the compiler to pre-populate the lib file cache.
 */
import { preloadLibFiles } from "../src/index.js";

// Vite resolves this at build time — each matching file is imported as
// a raw string. The eager option inlines them directly (no lazy loading).
const libModules = import.meta.glob(
  "../node_modules/typescript/lib/lib.*.d.ts",
  { eager: true, query: "?raw", import: "default" },
) as Record<string, string>;

/**
 * Pre-populate the compiler's lib file cache with bundled TypeScript
 * lib declarations. Must be called once before any compile() call
 * in the browser.
 */
export function loadLibFiles(): void {
  const files: Record<string, string> = {};
  for (const [path, content] of Object.entries(libModules)) {
    // Extract just the filename from the full path
    // e.g. "../node_modules/typescript/lib/lib.es5.d.ts" -> "lib.es5.d.ts"
    const name = path.split("/").pop()!;
    files[name] = content;
  }
  preloadLibFiles(files);
}
