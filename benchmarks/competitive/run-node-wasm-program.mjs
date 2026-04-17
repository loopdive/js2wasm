import { readFileSync } from "node:fs";
import { buildImports, instantiateWasm } from "../../scripts/compiler-bundle.mjs";

const args = process.argv.slice(2);
const hotMode = args[0] === "--hot";
const measureMode = args[0] === "--measure";
const [wasmPath, manifestPath, exportName = "run", inputRaw, iterationsRaw] =
  hotMode || measureMode ? args.slice(1) : args;

if (
  !wasmPath ||
  !manifestPath ||
  !exportName ||
  inputRaw == null ||
  ((hotMode || measureMode) && iterationsRaw == null)
) {
  console.error(
    "Usage: node run-node-wasm-program.mjs [--hot|--measure] <module.wasm> <manifest.json> <exportName> <input> [iterations]",
  );
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const wasmBytes = new Uint8Array(readFileSync(wasmPath));
const imports = buildImports(manifest.imports ?? [], {}, manifest.stringPool ?? []);
const { instance } = await instantiateWasm(wasmBytes, imports.env, imports.string_constants);
if (imports.setExports) imports.setExports(instance.exports);

const entry = instance.exports[exportName];
if (typeof entry !== "function") {
  console.error(`Module ${wasmPath} does not export ${exportName}(input)`);
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
    process.stdout.write(
      JSON.stringify({ result: typeof result === "bigint" ? Number(result) : result, durationMs }) + "\n",
    );
    process.exit(0);
  }
  result = await entry(input);
}
process.stdout.write(JSON.stringify({ result: typeof result === "bigint" ? Number(result) : result }) + "\n");
