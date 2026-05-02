#!/usr/bin/env node
// Deprecated thin wrapper — functionality moved to scripts/update-issues.mjs.
// Translates old flags to update-issues.mjs equivalents.

import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

// Map old flags: --write → (no --check), default → --check, --sync-body-status → pass through
const forwardArgs = [];
if (!args.includes("--write")) forwardArgs.push("--check");
if (args.includes("--sync-body-status")) forwardArgs.push("--sync-body-status");
// Pass through non-flag args (specific file targets)
forwardArgs.push(...args.filter((a) => !a.startsWith("--")));

execFileSync("node", [resolve(ROOT, "scripts/update-issues.mjs"), ...forwardArgs], {
  stdio: "inherit",
  cwd: ROOT,
});
