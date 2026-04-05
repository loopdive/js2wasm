// Browser stub for node:fs — all operations are no-ops in browser context.
export function readFileSync() {
  return "";
}
export function writeFileSync() {}
export function existsSync() {
  return false;
}
export function mkdirSync() {}
export function readdirSync() {
  return [];
}
export function statSync() {
  return { isFile: () => false, isDirectory: () => false };
}
export function realpathSync(p) {
  return p;
}
export default { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, realpathSync };
