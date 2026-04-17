#!/usr/bin/env node

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
    fail("usage: starlingmonkey-componentize-adapter.mjs <input.js> <output.wasm>");
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
  const enableAot = parseBoolEnv("STARLINGMONKEY_COMPONENTIZE_AOT", false);
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

  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "starlingmonkey-componentize-"));
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
