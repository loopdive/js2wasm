#!/usr/bin/env node

/**
 * Backwards-compatible shim for the StarlingMonkey + ComponentizeJS benchmark
 * adapter. The canonical implementation now lives at:
 *
 *   benchmarks/competitive/sm-componentize-adapter.mjs
 *
 * (See #1125.) This shim simply forwards to the canonical adapter so any docs,
 * env vars, or external scripts that point at the old path keep working.
 * Prefer the new path going forward.
 */

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const adapterPath = resolve(__dirname, "..", "benchmarks", "competitive", "sm-componentize-adapter.mjs");
await import(pathToFileURL(adapterPath).href);
