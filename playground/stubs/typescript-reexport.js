// Thin re-export so the compiler bundle (served outside Vite's pipeline)
// can import typescript via a Vite-resolvable URL.
// Bundle only uses default import (`import ts from "typescript"`).
export { default } from "typescript";
