// Entry point for the compiler bundle — re-exports everything the playground needs.
// Used by `build:compiler-bundle` to produce scripts/compiler-bundle.mjs.
export * from "../src/index.ts";
export { optimizeBinaryAsync } from "../src/optimize.ts";
