#!/usr/bin/env node
// Prints the next free issue ID by scanning all plan/issues/ subdirectories.

import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ISSUES_DIR = join(ROOT, "plan", "issues");

function scanDir(dir) {
  let max = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      max = Math.max(max, scanDir(join(dir, entry.name)));
    } else {
      const m = entry.name.match(/^(\d+)(?:[-_].+)?\.md$/);
      if (m) max = Math.max(max, Number(m[1]));
    }
  }
  return max;
}

let max = scanDir(ISSUES_DIR);

process.stdout.write(String(max + 1) + "\n");
