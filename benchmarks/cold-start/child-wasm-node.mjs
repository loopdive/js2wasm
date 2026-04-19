/**
 * Child process: load and run a precompiled .wasm module in Node.js.
 * Usage: node child-wasm-node.mjs <module.wasm> <manifest.json> <input>
 *
 * Builds minimal imports inline to avoid depending on the compiler bundle.
 */
import { readFileSync } from "node:fs";

const [wasmPath, manifestPath, inputRaw] = process.argv.slice(2);
if (!wasmPath || !manifestPath || inputRaw == null) {
  process.stderr.write("Usage: node child-wasm-node.mjs <module.wasm> <manifest.json> <input>\n");
  process.exit(1);
}

const t0 = performance.now();
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const wasmBytes = new Uint8Array(readFileSync(wasmPath));

// Build minimal imports
const importObj = {};

// String constants pool (if needed)
if (manifest.stringPool && manifest.stringPool.length > 0) {
  importObj.string_constants = {};
  for (let i = 0; i < manifest.stringPool.length; i++) {
    importObj.string_constants[`s${i}`] = manifest.stringPool[i];
  }
}

// Minimal env stubs for host imports the benchmark programs may use
const envStubs = {
  __box_number: (v) => v,
  __unbox_number: (v) => (typeof v === "number" ? v : Number(v)),
  __get_undefined: () => undefined,
  __typeof: (v) => typeof v,
  __log: (v) => console.log(v),
  __throw_error: (msg) => {
    throw new Error(String(msg));
  },
  // String method stubs
  string_charAt: (s, i) => (typeof s === "string" ? s.charAt(i) : ""),
  string_charCodeAt: (s, i) => (typeof s === "string" ? s.charCodeAt(i) : 0),
  string_length: (s) => (typeof s === "string" ? s.length : 0),
  string_concat: (a, b) => String(a) + String(b),
  string_slice: (s, start, end) => String(s).slice(start, end),
  string_indexOf: (s, search) => String(s).indexOf(String(search)),
};

// Add env imports that the module actually needs
if (manifest.imports && manifest.imports.length > 0) {
  importObj.env = {};
  for (const imp of manifest.imports) {
    const name = imp.name || imp;
    if (envStubs[name]) {
      importObj.env[name] = envStubs[name];
    } else {
      // Generic stub for unknown imports
      importObj.env[name] = () => undefined;
    }
  }
}

// Use builtins for wasm:js-string if available
const compileOpts = { builtins: ["js-string"] };
const { instance } = await WebAssembly.instantiate(wasmBytes, importObj, compileOpts);
const loadMs = performance.now() - t0;

const entry = instance.exports.run;
if (typeof entry !== "function") {
  process.stderr.write(`Module ${wasmPath} does not export run()\n`);
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
