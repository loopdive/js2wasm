#!/usr/bin/env node
/**
 * Verify a sprint is fully closed before starting the next one.
 * Reads the wrap_checklist from the sprint.md frontmatter.
 *
 * Usage: node scripts/check-sprint-closed.mjs <N>
 * Exits 0 if all checklist items are true, 1 otherwise.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";

const N = process.argv[2];
if (!N || isNaN(Number(N))) {
  console.error("Usage: node scripts/check-sprint-closed.mjs <sprint-number>");
  process.exit(1);
}

const root = new URL("..", import.meta.url).pathname;
const sprintFile = join(root, `plan/issues/sprints/${N}/sprint.md`);

if (!existsSync(sprintFile)) {
  console.error(`❌ plan/issues/sprints/${N}/sprint.md not found`);
  process.exit(1);
}

// Parse YAML frontmatter (--- ... ---)
const content = readFileSync(sprintFile, "utf8");
const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
if (!fmMatch) {
  console.error("❌ No frontmatter found in sprint.md");
  process.exit(1);
}

// Minimal YAML parse for wrap_checklist block (no dep on js-yaml)
const fm = fmMatch[1];
const checklistMatch = fm.match(/^wrap_checklist:\n((?:  .+\n?)+)/m);
if (!checklistMatch) {
  console.error(`❌ No wrap_checklist in sprint ${N} frontmatter. Add it via /sprint-wrap-up.`);
  process.exit(1);
}

let allPass = true;
const lines = checklistMatch[1].trimEnd().split("\n");
for (const line of lines) {
  const m = line.match(/^\s+(\w+):\s*(true|false)$/);
  if (!m) continue;
  const [, key, val] = m;
  const pass = val === "true";
  console.log(`${pass ? "✅" : "❌"} ${key}`);
  if (!pass) allPass = false;
}

console.log("");
if (allPass) {
  console.log(`Sprint ${N} is fully closed. ✅`);
  process.exit(0);
} else {
  console.log(`Sprint ${N} closure incomplete. Run /sprint-wrap-up to fill missing items.`);
  process.exit(1);
}
