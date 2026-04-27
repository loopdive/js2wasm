#!/usr/bin/env node
// Sprint progress statusline for Claude Code.
// Reads plan/issues/sprints/{N}/*.md, counts status:done vs total,
// emits a colored badge: "sprint N  NN%"

import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SPRINTS_DIR = join(ROOT, "plan", "issues", "sprints");

function currentSprint() {
  const dirs = readdirSync(SPRINTS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d+$/.test(d.name))
    .map((d) => Number(d.name))
    .sort((a, b) => a - b);
  return dirs.at(-1) ?? 0;
}

function sprintProgress(n) {
  const dir = join(SPRINTS_DIR, String(n));
  const files = readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "sprint.md");
  let done = 0;
  for (const f of files) {
    const content = readFileSync(join(dir, f), "utf8");
    if (/^status:\s*done\b/m.test(content)) done++;
  }
  return { done, total: files.length };
}

function interpolateColor(pct) {
  // Hue 0 (red) → 60 (yellow) → 120 (green) via HSL→RGB
  const hue = pct * 120;
  const h = hue / 60;
  const x = 1 - Math.abs((h % 2) - 1);
  let r, g, b;
  if (h < 1) {
    r = 1;
    g = x;
    b = 0;
  } else if (h < 2) {
    r = x;
    g = 1;
    b = 0;
  } else {
    r = 0;
    g = 1;
    b = x;
  }
  return [Math.round(r * 220), Math.round(g * 200), Math.round(b * 20)];
}

const sprint = currentSprint();
const { done, total } = sprintProgress(sprint);
const pct = total === 0 ? 0 : done / total;
const pctInt = Math.round(pct * 100);
const [r, g, b] = interpolateColor(pct);

// ANSI 24-bit foreground color + reset
const colored = `\x1b[38;2;${r};${g};${b}m`;
const reset = "\x1b[0m";

process.stdout.write(`${colored}sprint ${sprint}  ${pctInt}%${reset}`);
