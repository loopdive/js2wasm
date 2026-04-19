import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const hotMode = args[0] === "--hot";
const measureMode = args[0] === "--measure";
const [programPath, exportName = "run", inputRaw, iterationsRaw] = hotMode || measureMode ? args.slice(1) : args;

if (!programPath || !exportName || inputRaw == null || ((hotMode || measureMode) && iterationsRaw == null)) {
  console.error("Usage: node run-node-program.mjs [--hot|--measure] <program.js> <exportName> <input> [iterations]");
  process.exit(1);
}

const mod = await import(pathToFileURL(programPath).href);

const entry = mod[exportName];
if (typeof entry !== "function") {
  console.error(`Program ${programPath} does not export ${exportName}(input)`);
  process.exit(1);
}

const input = Number(inputRaw);
let result;
if (hotMode) {
  const iterations = Number(iterationsRaw);
  result = await entry(input);
  for (let i = 0; i < iterations; i++) {
    result = await entry(input);
  }
} else {
  if (measureMode) {
    const iterations = Number(iterationsRaw);
    result = await entry(input);
    const started = performance.now();
    for (let i = 0; i < iterations; i++) {
      result = await entry(input);
    }
    const durationMs = performance.now() - started;
    process.stdout.write(JSON.stringify({ result, durationMs }) + "\n");
    process.exit(0);
  }
  result = await entry(input);
}
process.stdout.write(JSON.stringify({ result }) + "\n");
