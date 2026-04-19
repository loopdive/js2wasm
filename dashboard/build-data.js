#!/usr/bin/env node
/**
 * build-data.js — Generates dashboard/data/ JSON files from project sources.
 * Run: node dashboard/build-data.js
 * No dependencies — uses only Node.js built-ins.
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, statSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import { execFileSync } from "node:child_process";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(import.meta.dirname, "data");
const SPRINT_ROOT = join(ROOT, "plan/issues/sprints");
const LEGACY_SPRINT_ROOT = join(ROOT, "plan/sprints");

mkdirSync(OUT, { recursive: true });

const ISSUE_ROOT = join(ROOT, "plan/issues");

function git(args) {
  return execFileSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function getTrackedMarkdownFiles(root) {
  try {
    return new Set(
      git(["ls-files", root])
        .split("\n")
        .map((file) => file.trim())
        .filter((file) => file.endsWith(".md"))
        .map((file) => join(ROOT, file)),
    );
  } catch {
    return null;
  }
}

function getStableGeneratedAt(paths) {
  const candidates = paths.filter((p) => existsSync(p));
  if (!candidates.length) return "";
  try {
    return git(["log", "-1", "--no-merges", "--format=%aI", "--", ...candidates]);
  } catch {
    return "";
  }
}

function isIssueFileName(name) {
  return /^\d+[a-z]?(?:-.+)?\.md$/i.test(name);
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

// ── Frontmatter parser ───────────────────────────────────────
function parseFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const obj = {};
  for (const line of m[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
      val = val.slice(1, -1);
    if (val.startsWith("[") && val.endsWith("]"))
      val = val
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    obj[key] = val;
  }
  return obj;
}

function extractTitle(text) {
  const m = text.match(/^#\s+.*?—\s*(.+)$/m) || text.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : "Untitled";
}

function extractSprintNumber(name) {
  const match = String(name).match(/(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

function extractSprintNumberFromLabel(label) {
  return extractSprintNumber(label);
}

// ── Load issues ──────────────────────────────────────────────
function normalizeIssueStatus(rawStatus) {
  const status = String(rawStatus || "").trim();
  if (status === "in_progress") return "in-progress";
  if (status === "in-review" || status === "in_review") return "review";
  if (status) return status;
  return "ready";
}

function loadIssues() {
  if (!existsSync(ISSUE_ROOT)) return [];
  const trackedFiles = getTrackedMarkdownFiles("plan/issues");
  return walkFiles(ISSUE_ROOT)
    .filter((file) => isIssueFileName(file.split("/").pop()))
    .filter((file) => !trackedFiles || trackedFiles.has(file))
    .map((file) => {
      const text = readFileSync(file, "utf-8");
      const f = file.split("/").pop();
      const fm = parseFrontmatter(text);
      const id = String(fm.id || f.replace(".md", ""));
      const title = fm.title || extractTitle(text);
      return {
        id,
        title,
        priority: fm.priority || "medium",
        feasibility: fm.feasibility || "",
        depends_on: fm.depends_on || [],
        goal: fm.goal || "",
        status: normalizeIssueStatus(fm.status),
        sprint: fm.sprint || "",
      };
    })
    .sort((a, b) => String(b.id).localeCompare(String(a.id), undefined, { numeric: true })); // newest first
}

const issues = {
  backlog: [],
  blocked: [],
  ready: [],
  inprogress: [],
  review: [],
  done: [],
  wontfix: [],
};

for (const iss of loadIssues()) {
  if (iss.status === "backlog") {
    issues.backlog.push(iss);
  } else if (iss.status === "blocked") {
    issues.blocked.push(iss);
  } else if (iss.status === "in-progress") {
    issues.inprogress.push(iss);
  } else if (iss.status === "review") {
    issues.review.push(iss);
  } else if (iss.status === "done") {
    issues.done.push(iss);
  } else if (iss.status === "wont-fix") {
    issues.wontfix.push(iss);
  } else {
    issues.ready.push(iss);
  }
}

const allIssueEntries = [
  ...issues.backlog,
  ...issues.ready,
  ...issues.inprogress,
  ...issues.review,
  ...issues.blocked,
  ...issues.done,
  ...issues.wontfix,
];
const issueIdsBySprint = new Map();
const completedIssueIdsBySprint = new Map();
for (const issue of allIssueEntries) {
  const sprintNumber = extractSprintNumberFromLabel(issue.sprint);
  if (!Number.isFinite(sprintNumber)) continue;
  if (!issueIdsBySprint.has(sprintNumber)) issueIdsBySprint.set(sprintNumber, new Set());
  issueIdsBySprint.get(sprintNumber).add(String(issue.id));
  if (issue.status === "done") {
    if (!completedIssueIdsBySprint.has(sprintNumber)) completedIssueIdsBySprint.set(sprintNumber, new Set());
    completedIssueIdsBySprint.get(sprintNumber).add(String(issue.id));
  }
}

writeFileSync(join(OUT, "issues.json"), JSON.stringify(issues, null, 2));
console.log(
  `Issues: ${issues.backlog.length} backlog, ${issues.ready.length} ready, ${issues.inprogress.length} in-progress, ${issues.review.length} in-review, ${issues.blocked.length} blocked, ${issues.done.length} done, ${issues.wontfix.length} wont-fix`,
);

// ── Load test262 runs ────────────────────────────────────────
const runsPath = join(ROOT, "benchmarks/results/runs/index.json");
let runs = [];
if (existsSync(runsPath)) {
  const all = JSON.parse(readFileSync(runsPath, "utf-8"));
  // Before Mar 20: smaller suite, keep all > 20K.
  // After the suite expansion, keep only full conformance runs and exclude
  // tiny crash artifacts, but do not require totals to stay near the old
  // proposal-inclusive 48K size because official-scope runs are lower.
  runs = all
    .filter((r) => {
      const ts = r.timestamp || "";
      if (ts < "2026-03-20") return r.total >= 20000;
      return r.total >= 40000;
    })
    .sort((a, b) => String(a.timestamp || "").localeCompare(String(b.timestamp || "")));
}
// Copy runs to data/ for the dashboard to fetch
writeFileSync(join(OUT, "runs.json"), JSON.stringify(runs));
console.log(`Test262 runs: ${runs.length} entries (filtered from raw data)`);

// ── Load sprints ─────────────────────────────────────────────
function findSprintFiles() {
  const files = [];
  for (const file of walkFiles(SPRINT_ROOT)) {
    if (!file.endsWith("/sprint.md")) continue;
    const sprintNumber = extractSprintNumber(basename(dirname(file)));
    if (Number.isFinite(sprintNumber)) files.push({ file, sprintNumber });
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

const sprints = [];
const sprintFiles = findSprintFiles();
for (const entry of sprintFiles) {
  const text = readFileSync(entry.file, "utf-8");
  const fm = parseFrontmatter(text);
  const name = `sprint ${entry.sprintNumber}`;

  // Extract date
  const dateM = text.match(/\*\*Date\*\*:\s*(.+)/);
  const date = dateM ? dateM[1].trim() : "";

  // Extract baseline
  const baseM = text.match(/\*\*Baseline\*\*:\s*(.+)/);
  const baseline = baseM ? baseM[1].trim() : "";

  // Extract result
  const resultM = text.match(/\*\*Final numbers?\*\*:\s*(.+)/i) || text.match(/\*\*Result\*\*:\s*(.+)/i);
  const result = resultM ? resultM[1].trim() : "";

  // Count merged issues
  const mergedCount = (text.match(/\*\*Merged\*\*/gi) || []).length;

  const sprintNumber = entry.sprintNumber;
  const explicitCarryOver =
    /Issues not completed in this sprint were returned to the backlog/i.test(text) ||
    /moved into \[sprint-\d+\.md\]/i.test(text) ||
    /contains only the unfinished carry-over work/i.test(text);
  const issueIds =
    sprintNumber != null
      ? [...(issueIdsBySprint.get(sprintNumber) || new Set())].sort((a, b) =>
          String(a).localeCompare(String(b), undefined, { numeric: true }),
        )
      : [];
  const completedIssueIds =
    sprintNumber != null
      ? [...(completedIssueIdsBySprint.get(sprintNumber) || new Set())].sort((a, b) =>
          String(a).localeCompare(String(b), undefined, { numeric: true }),
        )
      : [];
  sprints.push({
    name,
    sprintNumber,
    status: fm.status || "",
    date,
    baseline,
    result,
    issueCount: mergedCount,
    issueIds,
    completedIssueIds,
    explicitCarryOver,
  });
}
const maxSprintNumber = Math.max(...sprints.map((s) => s.sprintNumber || 0), 0);
for (const sprint of sprints) {
  sprint.isClosed = Boolean(sprint.sprintNumber && sprint.sprintNumber < maxSprintNumber) || sprint.explicitCarryOver;
}
writeFileSync(join(OUT, "sprints.json"), JSON.stringify(sprints, null, 2));
console.log(`Sprints: ${sprints.length} entries`);

// ── Also write embedded data for file:// mode ────────────────
const embedded = `// Auto-generated by build-data.js — do not edit
window.__DASHBOARD_DATA__ = ${JSON.stringify({ issues, runs, sprints })};
`;
writeFileSync(join(import.meta.dirname, "data.js"), embedded);
console.log("Wrote dashboard/data.js (embedded mode)");

// Graph files live in public/ (served by Vite + included in pages-dist via build)

console.log("Done. Open dashboard/index.html in a browser.");
