#!/usr/bin/env node
// Prints the next free issue ID by scanning all plan/issues/ subdirectories.

import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ISSUES_DIR = join(ROOT, "plan", "issues");

const subdirs = readdirSync(ISSUES_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

let max = 0;
for (const sub of subdirs) {
  for (const f of readdirSync(join(ISSUES_DIR, sub))) {
    const m = f.match(/^(\d+)\.md$/);
    if (m) max = Math.max(max, Number(m[1]));
  }
}

process.stdout.write(String(max + 1) + "\n");
