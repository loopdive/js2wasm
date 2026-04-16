#!/usr/bin/env node

import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = resolve(import.meta.dirname, "..");
const VENDOR_DIR = join(ROOT, "vendor");

const SOURCES = [
  {
    name: "AssemblyScript",
    type: "git",
    repo: "https://github.com/AssemblyScript/assemblyscript.git",
    ref: "v0.28.14",
    postSetup: [
      {
        command: "pnpm",
        args: ["install", "--frozen-lockfile"],
      },
    ],
  },
  {
    name: "Porffor",
    type: "git",
    repo: "https://github.com/CanadaHonk/porffor.git",
    ref: "84fdcda4741ed2ee1383ae65e15743869cd6c017",
  },
  {
    name: "StarlingMonkey",
    type: "git",
    repo: "https://github.com/bytecodealliance/StarlingMonkey.git",
    ref: "9dda8ba7fcda2e17c6795d402f0478cf4c1f7f37",
  },
];

function writeVendorReadme() {
  const readmePath = join(VENDOR_DIR, "README.md");
  writeFileSync(
    readmePath,
    `# Local Benchmark Vendor Cache

This directory is intentionally local-only and gitignored.

It exists only to make the benchmark harness defaults convenient when you want
local fallback toolchains under \`vendor/\`.

## Recreate

\`\`\`bash
pnpm run setup:benchmark-vendors
\`\`\`

## Contents

- \`AssemblyScript/\`
- \`Porffor/\`
- \`StarlingMonkey/\`
- \`Javy/\` if local Javy sources were provided

## StarlingMonkey

The setup script checks out the pinned StarlingMonkey source tree, but does not
fully build it for you.

Expected runtime artifact for the benchmark harness:

\`\`\`text
vendor/StarlingMonkey/cmake-build-release/starling.wasm
\`\`\`

Typical next step is to configure and build StarlingMonkey in its checkout, for
example with its upstream CMake instructions.

If you do not want to rely on the local \`vendor/\` fallback, point the harness
at explicit paths instead:

\`\`\`bash
export STARLINGMONKEY_ROOT=/path/to/StarlingMonkey
export STARLINGMONKEY_BUILD_DIR=/path/to/StarlingMonkey/cmake-build-release
export STARLINGMONKEY_RUNTIME=/path/to/StarlingMonkey/cmake-build-release/starling.wasm
export STARLINGMONKEY_WASMTIME_BIN=/path/to/wasmtime
\`\`\`

## Javy

The setup script cannot guess the correct Javy binary and plugin artifact for
every platform. To populate \`vendor/Javy/\`, provide:

\`\`\`bash
JAVY_BIN_SOURCE=/path/to/javy \\
JAVY_PLUGIN_SOURCE=/path/to/plugin.wasm \\
pnpm run setup:benchmark-vendors
\`\`\`

If you prefer not to stage them under \`vendor/\`, point the harness at the
artifacts directly:

\`\`\`bash
export JAVY_BIN=/path/to/javy
export JAVY_PLUGIN=/path/to/plugin.wasm
\`\`\`
`,
    "utf8",
  );
}

function run(command, args, cwd = ROOT) {
  execFileSync(command, args, {
    cwd,
    stdio: "inherit",
  });
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

function syncGitSource(source) {
  const dest = join(VENDOR_DIR, source.name);

  if (!existsSync(dest)) {
    run("git", ["clone", source.repo, dest]);
  }

  run("git", ["fetch", "--all", "--tags"], dest);
  run("git", ["checkout", source.ref], dest);

  for (const step of source.postSetup || []) {
    run(step.command, step.args, dest);
  }
}

function maybeInstallJavy() {
  const javyDir = join(VENDOR_DIR, "Javy");
  ensureDir(javyDir);

  const binSource = process.env.JAVY_BIN_SOURCE || "";
  const pluginSource = process.env.JAVY_PLUGIN_SOURCE || "";
  const binDest = join(javyDir, "javy");
  const pluginDest = join(javyDir, "plugin.wasm");

  if (binSource && existsSync(binSource)) {
    copyFileSync(binSource, binDest);
    chmodSync(binDest, 0o755);
  }

  if (pluginSource && existsSync(pluginSource)) {
    copyFileSync(pluginSource, pluginDest);
  }

  if (!existsSync(binDest) || !existsSync(pluginDest)) {
    console.log("");
    console.log("Javy was not fully provisioned.");
    console.log("Provide local sources and rerun:");
    console.log("  JAVY_BIN_SOURCE=/path/to/javy \\");
    console.log("  JAVY_PLUGIN_SOURCE=/path/to/plugin.wasm \\");
    console.log("  node scripts/setup-benchmark-vendors.mjs");
    console.log("");
  }
}

function main() {
  if (process.argv.includes("--fresh")) {
    rmSync(VENDOR_DIR, { recursive: true, force: true });
  }

  ensureDir(VENDOR_DIR);

  for (const source of SOURCES) {
    syncGitSource(source);
  }

  maybeInstallJavy();
  writeVendorReadme();

  console.log("");
  console.log("Vendor benchmark toolchains are prepared under vendor/.");
  console.log("This directory is intentionally gitignored.");
  console.log("");
  console.log("Default benchmark fallbacks now resolve to:");
  console.log(`  ${join(VENDOR_DIR, "AssemblyScript")}`);
  console.log(`  ${join(VENDOR_DIR, "Porffor")}`);
  console.log(`  ${join(VENDOR_DIR, "StarlingMonkey")}`);
  console.log(`  ${join(VENDOR_DIR, "Javy")}`);
}

main();
