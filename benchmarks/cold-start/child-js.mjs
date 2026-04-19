/**
 * Child process: run a JS program and report timing.
 * Usage: node child-js.mjs <program.js> <input>
 */
import { pathToFileURL } from "node:url";

const [programPath, inputRaw] = process.argv.slice(2);
if (!programPath || inputRaw == null) {
  process.stderr.write("Usage: node child-js.mjs <program.js> <input>\n");
  process.exit(1);
}

const t0 = performance.now();
const mod = await import(pathToFileURL(programPath).href);
const loadMs = performance.now() - t0;

const entry = mod.run;
if (typeof entry !== "function") {
  process.stderr.write(`Program ${programPath} does not export run()\n`);
  process.exit(1);
}

const t1 = performance.now();
const result = entry(Number(inputRaw));
const execMs = performance.now() - t1;

process.stdout.write(
  JSON.stringify({
    result: typeof result === "bigint" ? Number(result) : result,
    loadMs: Math.round(loadMs * 1000) / 1000,
    execMs: Math.round(execMs * 1000) / 1000,
  }) + "\n",
);
