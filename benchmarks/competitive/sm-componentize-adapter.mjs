#!/usr/bin/env node

/**
 * StarlingMonkey + ComponentizeJS benchmark adapter (#1125).
 *
 * Contract used by `benchmarks/compare-runtimes.ts`:
 *
 *   STARLINGMONKEY_ADAPTER=$PWD/benchmarks/competitive/sm-componentize-adapter.mjs
 *   $STARLINGMONKEY_ADAPTER <input.js> <output.wasm>
 *
 * The adapter takes the benchmark's pure-JS module, attaches a synthesized
 * `<entry>-hot` loop export, generates a tiny WIT world, and feeds both into
 * `@bytecodealliance/componentize-js`. ComponentizeJS performs:
 *
 *   1. Wizer pre-initialization (always, baked into ComponentizeJS) — produces a
 *      snapshot of the StarlingMonkey embedding with the user module already
 *      parsed and global initialization complete. This is what materially
 *      reduces cold start vs the runtime-eval lane.
 *   2. Optional Weval AOT specialization (`STARLINGMONKEY_COMPONENTIZE_AOT=1`,
 *      enabled by default for #1125) — partially evaluates the SpiderMonkey
 *      interpreter against the snapshotted module so hot calls bypass interpreter
 *      dispatch. This is what materially reduces hot runtime vs Wizer-only.
 *
 * Final output is a single Wasm component at `<output.wasm>` plus a sidecar
 * `<output.wasm>.json` describing invoke export names and which post-processing
 * passes ran. The harness reads the sidecar to call `run` / `run-hot`.
 *
 * No system Wizer or Weval install is required: ComponentizeJS bundles
 * `@bytecodealliance/wizer` and `@bytecodealliance/weval` as dependencies. The
 * Weval native binary is downloaded on first use; subsequent runs are cached.
 *
 * Required env vars: none (sane defaults).
 *
 * Optional env vars:
 *   STARLINGMONKEY_COMPONENTIZE_AOT=0
 *     Disable Weval AOT specialization. Wizer snapshotting still runs.
 *   STARLINGMONKEY_WIZER_BIN=/path/to/wizer
 *   STARLINGMONKEY_WEVAL_BIN=/path/to/weval
 *     Use externally installed binaries instead of the bundled ones.
 *   STARLINGMONKEY_COMPONENTIZE_DISABLE_FEATURES=random,stdio,clocks,http,fetch-event
 *     Comma-separated list of WASI subsystems to strip from the embedding.
 *   STARLINGMONKEY_ENTRY_EXPORT=run
 *   STARLINGMONKEY_HOT_EXPORT=runHot
 *   STARLINGMONKEY_COMPONENT_WORLD=benchmark
 *     Override how the harness binds the benchmark export.
 *   COMPONENTIZE_JS_BIN=/path/to/componentize-js
 *     Force CLI fallback instead of `import("@bytecodealliance/componentize-js")`.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseBoolEnv(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  return /^(1|true|yes|on)$/i.test(raw);
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toWitName(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/_/g, "-")
    .toLowerCase();
}

function toJsExportName(name) {
  return name.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
}

function createCompileSource(source, fileName, entryExport, hotExport) {
  if (!new RegExp(`export function ${escapeRegex(entryExport)}\\s*\\(`).test(source)) {
    throw new Error(`Could not find exported ${entryExport}() in ${fileName}`);
  }
  const bodySource = source.replace(/^export const benchmark\s*=\s*\{[\s\S]*?\};\n*/m, "").trim();
  return `${bodySource}

/**
 * @param {number} iterations
 * @param {number} input
 * @returns {number}
 */
export function ${hotExport}(iterations, input) {
  let result = ${entryExport}(input);
  for (let i = 0; i < iterations; i++) {
    result = ${entryExport}(input);
  }
  return result;
}
`;
}

function createWitSource(worldName, entryExport, hotExport) {
  return `package local:benchmark;

world ${worldName} {
  export ${toWitName(entryExport)}: func(input: s32) -> s32;
  export ${toWitName(hotExport)}: func(iterations: s32, input: s32) -> s32;
}
`;
}

async function componentizeWithLibrary(options) {
  const { componentize } = await import("@bytecodealliance/componentize-js");
  const args = {
    sourcePath: options.sourcePath,
    witPath: options.witPath,
    enableAot: options.enableAot,
  };
  if (options.disableFeatures.length > 0) {
    args.disableFeatures = options.disableFeatures;
  }
  if (options.wizerBin) {
    args.wizerBin = options.wizerBin;
  }
  if (options.wevalBin) {
    args.wevalBin = options.wevalBin;
  }
  const { component } = await componentize(args);
  writeFileSync(options.outputPath, component);
}

function componentizeWithCli(options) {
  const componentizeBin = process.env.COMPONENTIZE_JS_BIN || "componentize-js";
  const args = ["--wit", options.witPath, "-o", options.outputPath];
  if (options.enableAot) {
    args.push("--aot");
  }
  args.push(options.sourcePath);
  const result = spawnSync(componentizeBin, args, {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  if (result.status !== 0) {
    const details = [result.stderr, result.stdout]
      .map((part) => part?.trim())
      .filter(Boolean)
      .join("\n");
    throw new Error(details || `ComponentizeJS CLI failed. Set COMPONENTIZE_JS_BIN if the binary is not on PATH.`);
  }
}

async function main() {
  const [inputPathArg, outputPathArg] = process.argv.slice(2);
  if (!inputPathArg || !outputPathArg) {
    fail("usage: sm-componentize-adapter.mjs <input.js> <output.wasm>");
  }

  const inputPath = path.resolve(inputPathArg);
  const outputPath = path.resolve(outputPathArg);
  if (!existsSync(inputPath)) {
    fail(`input file not found: ${inputPath}`);
  }
  mkdirSync(path.dirname(outputPath), { recursive: true });

  const entryExport = process.env.STARLINGMONKEY_ENTRY_EXPORT || "run";
  const hotExport = process.env.STARLINGMONKEY_HOT_EXPORT || toJsExportName(`${toWitName(entryExport)}-hot`);
  const worldName = process.env.STARLINGMONKEY_COMPONENT_WORLD || "benchmark";
  // #1125: Wizer always runs (built into ComponentizeJS). Weval AOT is
  // default-on for the documented "ComponentizeJS + Wizer + Weval" lane,
  // because Weval is what materially changes hot-runtime characteristics.
  const enableAot = parseBoolEnv("STARLINGMONKEY_COMPONENTIZE_AOT", true);
  const wizerBin = process.env.STARLINGMONKEY_WIZER_BIN || "";
  const wevalBin = process.env.STARLINGMONKEY_WEVAL_BIN || "";
  const disableFeatures = (
    process.env.STARLINGMONKEY_COMPONENTIZE_DISABLE_FEATURES || "random,stdio,clocks,http,fetch-event"
  )
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  const source = readFileSync(inputPath, "utf8");
  const compileSource = createCompileSource(source, path.basename(inputPath), entryExport, hotExport);
  const witSource = createWitSource(worldName, entryExport, hotExport);

  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "sm-componentize-"));
  try {
    const sourcePath = path.join(tmpDir, path.basename(inputPath));
    const witPath = path.join(tmpDir, `${worldName}.wit`);
    writeFileSync(sourcePath, compileSource, "utf8");
    writeFileSync(witPath, witSource, "utf8");

    let usedLibraryImport = false;
    try {
      await componentizeWithLibrary({
        sourcePath,
        witPath,
        outputPath,
        enableAot,
        disableFeatures,
        wizerBin,
        wevalBin,
      });
      usedLibraryImport = true;
    } catch (libraryError) {
      try {
        componentizeWithCli({
          sourcePath,
          witPath,
          outputPath,
          enableAot,
        });
      } catch (cliError) {
        const libraryMessage = libraryError instanceof Error ? libraryError.message : String(libraryError);
        const cliMessage = cliError instanceof Error ? cliError.message : String(cliError);
        throw new Error(
          `Failed to componentize benchmark with either the local @bytecodealliance/componentize-js library or the ComponentizeJS CLI.\n\nLibrary path failed with:\n${libraryMessage}\n\nCLI path failed with:\n${cliMessage}`,
        );
      }
    }

    const metadata = {
      kind: "component",
      invokeExport: toWitName(entryExport),
      hotInvokeExport: toWitName(hotExport),
      componentize: {
        world: worldName,
        // Wizer always runs as part of ComponentizeJS; document it explicitly
        // so consumers don't have to infer it from `enableAot`.
        wizerEnabled: true,
        wevalAotEnabled: enableAot,
        // Legacy field, kept for backward compatibility with the previous
        // `scripts/starlingmonkey-componentize-adapter.mjs` schema.
        enableAot,
        usedLibraryImport,
        disableFeatures,
        wizerBin: wizerBin || null,
        wevalBin: wevalBin || null,
      },
    };
    writeFileSync(`${outputPath}.json`, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
