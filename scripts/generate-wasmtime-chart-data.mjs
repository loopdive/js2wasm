#!/usr/bin/env node
/**
 * Transform runtime-compare-latest.json → 3 chart JSON files consumed by
 * <perf-benchmark-chart mode="absolute-lower-better"> on the landing page.
 *
 *   benchmarks/results/wasm-host-wasmtime-coldstart.json
 *   benchmarks/results/wasm-host-wasmtime-hot-runtime.json
 *   benchmarks/results/wasm-host-wasmtime-module-size.json
 *
 * Each file is an array of { name, label, value, jsUs } where:
 *   value  — js2wasm-wasmtime median measurement (ms converted to µs for consistency)
 *   jsUs   — Node.js baseline median measurement (µs)
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RESULTS_DIR = resolve(ROOT, "benchmarks", "results");
const INPUT = resolve(RESULTS_DIR, "runtime-compare-latest.json");

const payload = JSON.parse(readFileSync(INPUT, "utf8"));
const results = payload.results ?? [];

const coldstart = [];
const hotRuntime = [];
const moduleSize = [];

for (const program of results) {
  const name = program.id ?? program.label;
  const label = program.label ?? program.id;

  const baselineColdMs = program.baselineResult?.coldValue ?? null;
  const baselineRuntimeMs = program.baselineResult?.runtimeValue ?? null;

  for (const tc of program.toolchains ?? []) {
    if (tc.id !== "js2wasm-wasmtime") continue;
    if (tc.status !== "ok" && tc.status !== "success") continue;

    const entry = { name, label };

    if (tc.coldStart?.medianMs != null) {
      coldstart.push({
        ...entry,
        value: tc.coldStart.medianMs * 1000,
        jsUs: baselineColdMs != null ? baselineColdMs * 1000 : 0,
      });
    }

    if (tc.runtime?.medianMs != null) {
      hotRuntime.push({
        ...entry,
        value: tc.runtime.medianMs * 1000,
        jsUs: baselineRuntimeMs != null ? baselineRuntimeMs * 1000 : 0,
      });
    }

    if (tc.gzipBytes != null) {
      moduleSize.push({
        ...entry,
        value: tc.gzipBytes,
        jsUs: program.sourceGzipBytes ?? 0,
      });
    }
  }
}

function write(filename, data) {
  const path = resolve(RESULTS_DIR, filename);
  mkdirSync(RESULTS_DIR, { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
  console.log(`Wrote ${path} (${data.length} entries)`);
  const pubPath = resolve(ROOT, "public", "benchmarks", "results", filename);
  mkdirSync(dirname(pubPath), { recursive: true });
  writeFileSync(pubPath, JSON.stringify(data, null, 2) + "\n");
  console.log(`Copied to ${pubPath}`);
}

write("wasm-host-wasmtime-coldstart.json", coldstart);
write("wasm-host-wasmtime-hot-runtime.json", hotRuntime);
write("wasm-host-wasmtime-module-size.json", moduleSize);
