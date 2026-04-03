// Thin re-export so the compiler bundle (served outside Vite's pipeline)
// can import typescript via a Vite-resolvable URL.
// Vite transforms this file and rewrites the bare specifier to the pre-bundled dep.
export * from "typescript";
export { default } from "typescript";
