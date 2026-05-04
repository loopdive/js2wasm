#!/usr/bin/env node
// Deprecated thin wrapper — functionality moved to scripts/update-issues.mjs.

import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

// --check was the audit-only flag in sync-reverse-deps; maps to --check in update-issues
const forwardArgs = args.includes("--check") ? ["--check"] : [];

execFileSync("node", [resolve(ROOT, "scripts/update-issues.mjs"), ...forwardArgs], {
  stdio: "inherit",
  cwd: ROOT,
});
