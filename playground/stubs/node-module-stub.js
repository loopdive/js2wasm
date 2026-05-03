// Stub for node:module in browser builds. createRequire is Node-only.
export function createRequire() {
  return () => {
    throw new Error("require() is not available in browser builds");
  };
}
export default { createRequire };
