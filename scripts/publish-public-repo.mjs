#!/usr/bin/env node

import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { isAbsolute, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const DEFAULT_EXPORT_DIR = join(ROOT, ".tmp", "public-export");
const DEFAULT_PUBLIC_REPO_DIR = resolve(ROOT, "..", "js2wasm-public");

function parseArgs(argv) {
  const args = {
    repoDir: DEFAULT_PUBLIC_REPO_DIR,
    exportDir: DEFAULT_EXPORT_DIR,
    publicRemote: "https://github.com/loopdive/js2wasm.git",
    allowDirty: false,
    commit: false,
    push: false,
    message: "chore(public): refresh exported mirror",
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") continue;
    if (arg === "--repo-dir") args.repoDir = argv[++i] || args.repoDir;
    else if (arg === "--export-dir") args.exportDir = argv[++i] || args.exportDir;
    else if (arg === "--public-remote") args.publicRemote = argv[++i] || args.publicRemote;
    else if (arg === "--allow-dirty") args.allowDirty = true;
    else if (arg === "--commit") args.commit = true;
    else if (arg === "--push") args.push = true;
    else if (arg === "--message") args.message = argv[++i] || args.message;
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (args.push && !args.commit) {
    throw new Error("--push requires --commit");
  }

  return {
    ...args,
    repoDir: isAbsolute(args.repoDir) ? args.repoDir : resolve(ROOT, args.repoDir),
    exportDir: isAbsolute(args.exportDir) ? args.exportDir : resolve(ROOT, args.exportDir),
  };
}

function printHelp() {
  console.log(`Usage: node scripts/publish-public-repo.mjs [options]

Options:
  --repo-dir <path>        Target public repo checkout (default: ../js2wasm-public)
  --export-dir <path>      Temporary export staging dir (default: .tmp/public-export)
  --public-remote <url>    Expected public origin remote
  --allow-dirty            Allow syncing into a dirty public checkout
  --commit                 Commit the synced public changes
  --push                   Push after committing
  --message <text>         Commit message for --commit
  -h, --help               Show this help
`);
}

function run(command, args, options = {}) {
  const result = execFileSync(command, args, {
    cwd: options.cwd ?? ROOT,
    encoding: "utf8",
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
  });
  return typeof result === "string" ? result.trim() : "";
}

function runNodeScript(scriptName, scriptArgs) {
  run(process.execPath, [join(ROOT, "scripts", scriptName), ...scriptArgs], {
    stdio: "inherit",
  });
}

function listChangedPaths(repoDir) {
  const output = run("git", ["status", "--porcelain=v1", "-z"], { cwd: repoDir });
  if (!output) return [];

  const paths = [];
  let index = 0;
  while (index < output.length) {
    const status = output.slice(index, index + 2);
    index += 3;

    const end = output.indexOf("\0", index);
    if (end === -1) break;
    const firstPath = output.slice(index, end);
    index = end + 1;
    paths.push(firstPath);

    if (status.includes("R") || status.includes("C")) {
      const secondEnd = output.indexOf("\0", index);
      if (secondEnd === -1) break;
      const secondPath = output.slice(index, secondEnd);
      index = secondEnd + 1;
      paths.push(secondPath);
    }
  }

  return [...new Set(paths.filter(Boolean))];
}

function stageChangedPaths(repoDir) {
  const changedPaths = listChangedPaths(repoDir);
  if (changedPaths.length === 0) {
    return false;
  }

  run("git", ["add", "--", ...changedPaths], { cwd: repoDir, stdio: "inherit" });
  return true;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!existsSync(args.repoDir)) {
    throw new Error(`Public repo checkout does not exist: ${args.repoDir}`);
  }

  runNodeScript("export-public-tree.mjs", ["--out", args.exportDir]);
  const syncArgs = ["--repo-dir", args.repoDir, "--export-dir", args.exportDir, "--public-remote", args.publicRemote];
  if (args.allowDirty) {
    syncArgs.push("--allow-dirty");
  }
  runNodeScript("sync-public-repo.mjs", syncArgs);

  const changedPaths = listChangedPaths(args.repoDir);
  if (changedPaths.length === 0) {
    console.log("Public repo already matches the exported tree.");
    return;
  }

  console.log(`Public repo changed paths: ${changedPaths.length}`);

  if (!args.commit) {
    console.log("Sync complete. Review and commit in the public repo when ready.");
    return;
  }

  stageChangedPaths(args.repoDir);
  run("git", ["commit", "-m", args.message], { cwd: args.repoDir, stdio: "inherit" });

  if (args.push) {
    run("git", ["push", "origin", "main"], { cwd: args.repoDir, stdio: "inherit" });
  }
}

main();
