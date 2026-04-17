import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const porfforRoot = process.env.PORFFOR_ROOT || path.resolve(ROOT, "vendor", "Porffor");
const porfforWrapPath = process.env.PORFFOR_WRAP || path.join(porfforRoot, "compiler", "wrap.js");
const { default: compile } = await import(pathToFileURL(porfforWrapPath).href);

const args = process.argv.slice(2);
const hotMode = args[0] === "--hot";
const measureMode = args[0] === "--measure";
const [programPath, exportName = "run", inputRaw, iterationsRaw] = hotMode || measureMode ? args.slice(1) : args;

if (!programPath || !exportName || inputRaw == null || ((hotMode || measureMode) && iterationsRaw == null)) {
  console.error("Usage: node run-porffor-program.mjs [--hot|--measure] <program.js> <exportName> <input> [iterations]");
  process.exit(1);
}

const source = readFileSync(programPath, "utf8");
const out = compile(source, true);
const run = out.exports[exportName];

if (typeof run !== "function") {
  console.error(`Program ${programPath} does not export ${exportName}(input) for Porffor`);
  process.exit(1);
}

const input = Number(inputRaw);
let result;
if (hotMode) {
  const iterations = Number(iterationsRaw);
  result = run(input);
  for (let i = 0; i < iterations; i++) {
    result = run(input);
  }
} else if (measureMode) {
  const iterations = Number(iterationsRaw);
  result = run(input);
  const started = performance.now();
  for (let i = 0; i < iterations; i++) {
    result = run(input);
  }
  const durationMs = performance.now() - started;
  process.stdout.write(JSON.stringify({ result, durationMs }) + "\n");
  process.exit(0);
} else {
  result = run(input);
}

process.stdout.write(JSON.stringify({ result }) + "\n");
