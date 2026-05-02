#!/usr/bin/env node
// Backfill `sprint: <N>` into the YAML frontmatter of every issue file under
// plan/issues/sprints/<N>/ that doesn't already have one. The repo convention
// is "directory = sprint", but historically not every issue file's frontmatter
// captured this — and the dashboard build script reads the field rather than
// the directory, so missing entries dropped off the per-sprint board.
//
// Usage: node scripts/backfill-issue-sprint-frontmatter.mjs [--dry-run]
//
// Safe to run repeatedly: idempotent. Doesn't touch files that already have
// any `sprint:` line in frontmatter (even if the value disagrees with the
// directory — author intent wins).

import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");
const sprintsRoot = join(repoRoot, "plan", "issues", "sprints");

const dryRun = process.argv.includes("--dry-run");

function listSprintDirs() {
  return readdirSync(sprintsRoot)
    .filter((name) => /^\d+$/.test(name))
    .map((name) => ({ sprint: parseInt(name, 10), dir: join(sprintsRoot, name) }));
}

function isIssueFileName(name) {
  // Issue files match <id>-<slug>.md (id is numeric, optionally with a letter
  // suffix like 1169n). Excludes sprint.md, retrospective.md, etc.
  return /^\d+[a-z]?-.+\.md$/i.test(name);
}

/**
 * Insert `sprint: <N>` into the YAML frontmatter of `text` if a sprint key
 * is not already present. Returns the (possibly modified) text and a
 * boolean indicating whether a change was made.
 */
function ensureSprintFrontmatter(text, sprintNumber) {
  if (!text.startsWith("---\n")) return { text, changed: false };
  const end = text.indexOf("\n---", 4);
  if (end < 0) return { text, changed: false };
  const fm = text.slice(4, end);
  // Already has a `sprint:` key (anywhere in frontmatter, ignoring value)?
  if (/^sprint\s*:/m.test(fm)) return { text, changed: false };
  // Insert after the `id:` line if present, otherwise at the end of the
  // frontmatter block. Keep author-friendly ordering.
  let injected;
  const idMatch = fm.match(/^(id\s*:[^\n]*\n)/m);
  if (idMatch) {
    injected = fm.replace(idMatch[1], `${idMatch[1]}sprint: ${sprintNumber}\n`);
  } else {
    injected = `${fm.endsWith("\n") ? fm : fm + "\n"}sprint: ${sprintNumber}\n`;
  }
  return {
    text: `---\n${injected}${text.slice(end)}`,
    changed: true,
  };
}

let totalChecked = 0;
let totalChanged = 0;
const changedBySprintForLog = new Map();

for (const { sprint, dir } of listSprintDirs()) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    continue;
  }
  for (const name of names) {
    if (!isIssueFileName(name)) continue;
    const file = join(dir, name);
    if (!statSync(file).isFile()) continue;
    totalChecked++;
    const text = readFileSync(file, "utf-8");
    const { text: next, changed } = ensureSprintFrontmatter(text, sprint);
    if (!changed) continue;
    totalChanged++;
    const list = changedBySprintForLog.get(sprint) ?? [];
    list.push(name);
    changedBySprintForLog.set(sprint, list);
    if (!dryRun) writeFileSync(file, next);
  }
}

const verb = dryRun ? "would update" : "updated";
console.log(`${verb} ${totalChanged} of ${totalChecked} issue files`);
for (const [sprint, files] of [...changedBySprintForLog.entries()].sort((a, b) => a[0] - b[0])) {
  console.log(`  sprint ${sprint}: ${files.length} file${files.length === 1 ? "" : "s"}`);
}
if (dryRun) console.log("(dry run — re-run without --dry-run to apply)");
