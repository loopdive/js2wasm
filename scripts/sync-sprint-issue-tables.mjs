#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { basename, dirname, join, resolve } from "path";

const ROOT = resolve(import.meta.dirname, "..");
const ISSUE_ROOT = join(ROOT, "plan/issues");
const SPRINT_ROOT = join(ROOT, "plan/issues/sprints");
const LEGACY_SPRINT_ROOT = join(ROOT, "plan/sprints");

const START = "<!-- GENERATED_ISSUE_TABLES_START -->";
const END = "<!-- GENERATED_ISSUE_TABLES_END -->";
function isIssueFileName(name) {
  return /^\d+[a-z]?(?:[-_].+)?\.md$/i.test(name);
}

function parseFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const obj = {};
  for (const line of m[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    obj[key] = val;
  }
  return obj;
}

function extractTitle(text, fm) {
  if (fm.title) return fm.title;
  const m = text.match(/^#\s+.*?—\s*(.+)$/m) || text.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : "Untitled";
}

function extractSprintNumber(value) {
  const m = String(value || "").match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

function sprintFromPath(file) {
  const m = file.match(/\/sprints\/(\d+)\//);
  return m ? parseInt(m[1], 10) : null;
}

function walkFiles(root) {
  if (!existsSync(root)) return [];
  const out = [];
  for (const name of readdirSync(root)) {
    const file = join(root, name);
    const stat = statSync(file);
    if (stat.isDirectory()) {
      out.push(...walkFiles(file));
    } else {
      out.push(file);
    }
  }
  return out;
}

function normalizeStatus(dirName, fmStatus) {
  const normalized = String(fmStatus || "").trim();
  if (normalized === "backlog") return "backlog";
  if (normalized === "wont-fix") return "wont-fix";
  if (normalized === "done") return "done";
  if (normalized === "blocked") return "blocked";
  if (normalized === "review" || normalized === "in-review" || normalized === "in_review") return "review";
  if (normalized === "in-progress" || normalized === "in_progress") return "in-progress";
  if (normalized === "ready") return "ready";
  if (dirName === "done") return "done";
  if (dirName === "blocked") return "blocked";
  return "ready";
}

function loadIssues() {
  const issues = [];
  for (const file of walkFiles(ISSUE_ROOT)) {
    const name = file.split("/").pop();
    if (!isIssueFileName(name)) continue;
    const text = readFileSync(file, "utf8");
    const fm = parseFrontmatter(text);
    const sprintNumber = sprintFromPath(file);
    if (!Number.isFinite(sprintNumber)) continue;
    issues.push({
      id: String(fm.id || name.replace(/\.md$/, "")),
      title: extractTitle(text, fm),
      sprintNumber,
      status: normalizeStatus("", fm.status || ""),
      priority: fm.priority || "",
      path: file,
    });
  }
  return issues.sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
}

function renderTable(title, issues) {
  const lines = [`### ${title}`, "", "| Issue | Title | Priority | Status |", "|---|---|---|---|"];
  for (const issue of issues) {
    lines.push(`| #${issue.id} | ${issue.title.replace(/\|/g, "\\|")} | ${issue.priority || ""} | ${issue.status} |`);
  }
  lines.push("");
  return lines.join("\n");
}

function renderSprintSection(sprintNumber, issues) {
  const groups = [
    ["backlog", "Backlog"],
    ["blocked", "Blocked"],
    ["ready", "Ready"],
    ["in-progress", "In Progress"],
    ["review", "Review"],
    ["done", "Done"],
    ["wont-fix", "Won't Fix"],
  ];

  const lines = [
    START,
    "## Issue Tables",
    "",
    "_Generated from issue files. Update issue `status`, then rerun `node scripts/sync-sprint-issue-tables.mjs`._",
    "",
  ];

  for (const [key, label] of groups) {
    const groupIssues = issues.filter((issue) => issue.status === key);
    if (groupIssues.length === 0) continue;
    lines.push(renderTable(label, groupIssues));
  }

  if (issues.length === 0) {
    lines.push("No issues currently assigned to this sprint.", "");
  }

  lines.push(END, "");
  return lines.join("\n");
}

function findSprintFiles() {
  const files = [];
  for (const file of walkFiles(SPRINT_ROOT)) {
    if (file.endsWith("/sprint.md")) {
      const sprintNumber = extractSprintNumber(basename(dirname(file)));
      if (Number.isFinite(sprintNumber)) files.push({ file, sprintNumber });
    }
  }
  if (existsSync(LEGACY_SPRINT_ROOT)) {
    for (const name of readdirSync(LEGACY_SPRINT_ROOT)) {
      if (!/^sprint-\d+\.md$/.test(name)) continue;
      const file = join(LEGACY_SPRINT_ROOT, name);
      const sprintNumber = extractSprintNumber(name);
      if (Number.isFinite(sprintNumber)) files.push({ file, sprintNumber });
    }
  }
  return files.sort((a, b) => a.sprintNumber - b.sprintNumber);
}

function syncSprintFile(file, sprintNumber, issues) {
  const text = readFileSync(file, "utf8").replace(/\s*$/, "");
  const generated = renderSprintSection(
    sprintNumber,
    issues.filter((issue) => issue.sprintNumber === sprintNumber),
  );
  // The \\n? at the end of the pattern consumes the newline after END; add it
  // back so content that follows (e.g. hand-written sections) stays on a new line.
  const pattern = new RegExp(`${START}[\\s\\S]*?${END}\\n?`, "m");
  const next = pattern.test(text)
    ? text.replace(pattern, generated.trimEnd() + "\n")
    : `${text}\n\n${generated.trimEnd()}\n`;
  writeFileSync(file, next);
}

function main() {
  const args = process.argv.slice(2);
  const targetSprintNumbers =
    args.length > 0 ? args.map((arg) => parseInt(arg, 10)).filter((n) => Number.isFinite(n)) : null;

  const issues = loadIssues();
  const sprintFiles = findSprintFiles().filter(
    (entry) => !targetSprintNumbers || targetSprintNumbers.includes(entry.sprintNumber),
  );

  for (const entry of sprintFiles) {
    syncSprintFile(entry.file, entry.sprintNumber, issues);
    console.log(`synced sprint-${entry.sprintNumber}`);
  }
}

main();
