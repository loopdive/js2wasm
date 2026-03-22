// Empty stub for Node.js modules that can't run in the browser.
// Used by vite to replace node:child_process, node:os, etc.
export default {};
export const execFileSync = () => { throw new Error("Not available in browser"); };
export const tmpdir = () => "/tmp";
