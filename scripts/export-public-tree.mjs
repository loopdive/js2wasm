#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const DEFAULT_OUT_DIR = join(ROOT, "tmp", "public-export");
const ALLOWLIST_PATH = join(ROOT, "public-export", "allowlist.txt");
const DENYLIST_PATH = join(ROOT, "public-export", "denylist.txt");

function parseArgs(argv) {
  const args = { out: DEFAULT_OUT_DIR };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--out") {
      args.out = argv[++i];
    }
  }
  return args;
}

function readAllowlist(filePath) {
  return readFileSync(filePath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

function removeEntry(outDir, entry) {
  assertSafeRelativePath(entry);
  rmSync(join(outDir, entry), { recursive: true, force: true });
}

function assertSafeRelativePath(entry) {
  if (entry.startsWith("/") || entry.startsWith("../") || entry.includes("/../")) {
    throw new Error(`Unsafe allowlist entry: ${entry}`);
  }
}

function copyEntry(root, outDir, entry) {
  assertSafeRelativePath(entry);
  const source = join(root, entry);
  if (!existsSync(source)) {
    throw new Error(`Allowlisted path does not exist: ${entry}`);
  }
  const destination = join(outDir, entry);
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, {
    recursive: true,
    dereference: true,
  });
}

function main() {
  const { out } = parseArgs(process.argv.slice(2));
  const outDir = isAbsolute(out) ? out : resolve(ROOT, out);
  const allowlist = readAllowlist(ALLOWLIST_PATH);
  const denylist = existsSync(DENYLIST_PATH) ? readAllowlist(DENYLIST_PATH) : [];

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  for (const entry of allowlist) {
    copyEntry(ROOT, outDir, entry);
  }

  for (const entry of denylist) {
    removeEntry(outDir, entry);
  }

  console.log(
    `Exported ${allowlist.length} allowlisted paths to ${relative(ROOT, outDir) || "."} and pruned ${denylist.length} paths`,
  );
}

main();
