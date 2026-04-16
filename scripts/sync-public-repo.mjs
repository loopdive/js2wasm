#!/usr/bin/env node

import { cpSync, existsSync, readdirSync, rmSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = resolve(import.meta.dirname, "..");
const DEFAULT_EXPORT_DIR = join(ROOT, ".tmp", "public-export");
const DEFAULT_PUBLIC_REMOTE = "https://github.com/loopdive/js2wasm.git";

function parseArgs(argv) {
  const args = {
    repoDir: "",
    exportDir: DEFAULT_EXPORT_DIR,
    publicRemote: DEFAULT_PUBLIC_REMOTE,
    allowDirty: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--repo-dir") args.repoDir = argv[++i] || "";
    else if (arg === "--export-dir") args.exportDir = argv[++i] || DEFAULT_EXPORT_DIR;
    else if (arg === "--public-remote") args.publicRemote = argv[++i] || DEFAULT_PUBLIC_REMOTE;
    else if (arg === "--allow-dirty") args.allowDirty = true;
  }

  if (!args.repoDir) {
    throw new Error("Missing required argument: --repo-dir /path/to/public/js2wasm");
  }

  return {
    ...args,
    repoDir: isAbsolute(args.repoDir) ? args.repoDir : resolve(ROOT, args.repoDir),
    exportDir: isAbsolute(args.exportDir) ? args.exportDir : resolve(ROOT, args.exportDir),
  };
}

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function normalizeRemote(value) {
  return value
    .trim()
    .replace(/^git@github\.com:/, "github.com/")
    .replace(/^https?:\/\/github\.com\//, "github.com/")
    .replace(/\.git$/, "");
}

function assertRepoDir(repoDir, publicRemote, allowDirty) {
  if (!existsSync(join(repoDir, ".git"))) {
    throw new Error(`Target repo is missing .git: ${repoDir}`);
  }

  const origin = git(repoDir, ["remote", "get-url", "origin"]);
  if (!origin.includes("loopdive/js2wasm")) {
    throw new Error(`Target repo origin does not look like loopdive/js2wasm: ${origin}`);
  }
  if (origin.includes("js2wasm-private")) {
    throw new Error(`Target repo still points at the private remote: ${origin}`);
  }
  if (publicRemote && normalizeRemote(origin) !== normalizeRemote(publicRemote)) {
    throw new Error(`Target repo origin does not match expected public remote ${publicRemote}: ${origin}`);
  }

  if (!allowDirty) {
    const status = git(repoDir, ["status", "--short"]);
    if (status) {
      throw new Error(`Target repo has uncommitted changes:\n${status}`);
    }
  }
}

function wipeWorkingTree(repoDir) {
  for (const entry of readdirSync(repoDir, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    rmSync(join(repoDir, entry.name), { recursive: true, force: true });
  }
}

function copyExportTree(exportDir, repoDir) {
  for (const entry of readdirSync(exportDir, { withFileTypes: true })) {
    const source = join(exportDir, entry.name);
    const destination = join(repoDir, entry.name);
    cpSync(source, destination, {
      recursive: true,
      dereference: true,
    });
  }
}

function main() {
  const { repoDir, exportDir, publicRemote, allowDirty } = parseArgs(process.argv.slice(2));

  if (!existsSync(exportDir)) {
    throw new Error(`Export directory does not exist: ${exportDir}`);
  }

  assertRepoDir(repoDir, publicRemote, allowDirty);
  wipeWorkingTree(repoDir);
  copyExportTree(exportDir, repoDir);

  console.log(`Synced ${basename(exportDir)} into ${repoDir}`);
  console.log("Next steps:");
  console.log(`  cd ${repoDir}`);
  console.log("  git status --short");
  console.log('  git add <files> && git commit -m "chore(public): refresh public mirror"');
  console.log("  git push origin main");
}

main();
