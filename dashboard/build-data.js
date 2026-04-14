#!/usr/bin/env node
/**
 * build-data.js — Generates dashboard/data/ JSON files from project sources.
 * Run: node dashboard/build-data.js
 * No dependencies — uses only Node.js built-ins.
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from "fs";
import { join, resolve } from "path";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(import.meta.dirname, "data");

mkdirSync(OUT, { recursive: true });

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
function loadIssuesFromDir(dir) {
  if (!existsSync(dir)) return [];
  const dirName = dir.split("/").pop();
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      const text = readFileSync(join(dir, f), "utf-8");
      const fm = parseFrontmatter(text);
      const id = f.replace(".md", "");
      const title = fm.title || extractTitle(text);
      const rawStatus = String(fm.status || "").trim();
      const status =
        rawStatus ||
        (dirName === "done" ? "done" : dirName === "blocked" ? "blocked" : "ready");
      return {
        id,
        title,
        priority: fm.priority || "medium",
        feasibility: fm.feasibility || "",
        depends_on: fm.depends_on || [],
        goal: fm.goal || "",
        status,
        sprint: fm.sprint || "",
      };
    })
    .sort((a, b) => Number(b.id) - Number(a.id)); // newest first
}

const issues = {
  blocked: loadIssuesFromDir(join(ROOT, "plan/issues/blocked")),
  ready: loadIssuesFromDir(join(ROOT, "plan/issues/ready")),
  inprogress: [], // in-progress issues are in ready/ with status: in-progress
  review: [], // review issues are in ready/ with status: review
  done: loadIssuesFromDir(join(ROOT, "plan/issues/done")),
};

// Split ready into ready vs in-progress vs review based on frontmatter status
const ready = [];
for (const iss of issues.ready) {
  if (iss.status === "in-progress" || iss.status === "in_progress") {
    issues.inprogress.push(iss);
  } else if (iss.status === "review" || iss.status === "in-review" || iss.status === "in_review") {
    issues.review.push(iss);
  } else {
    ready.push(iss);
  }
}
issues.ready = ready;

const allIssueEntries = [...issues.ready, ...issues.inprogress, ...issues.review, ...issues.blocked, ...issues.done];
const issueIdsBySprint = new Map();
const completedIssueIdsBySprint = new Map();
for (const issue of allIssueEntries) {
  const sprintNumber = extractSprintNumberFromLabel(issue.sprint);
  if (!Number.isFinite(sprintNumber)) continue;
  if (!issueIdsBySprint.has(sprintNumber)) issueIdsBySprint.set(sprintNumber, new Set());
  issueIdsBySprint.get(sprintNumber).add(parseInt(issue.id, 10));
  if (issue.status === "done") {
    if (!completedIssueIdsBySprint.has(sprintNumber)) completedIssueIdsBySprint.set(sprintNumber, new Set());
    completedIssueIdsBySprint.get(sprintNumber).add(parseInt(issue.id, 10));
  }
}

writeFileSync(join(OUT, "issues.json"), JSON.stringify(issues, null, 2));
console.log(
  `Issues: ${issues.ready.length} ready, ${issues.inprogress.length} in-progress, ${issues.review.length} in-review, ${issues.blocked.length} blocked, ${issues.done.length} done`,
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
const sprintsDir = join(ROOT, "plan/sprints");
const sprints = [];
if (existsSync(sprintsDir)) {
  for (const f of readdirSync(sprintsDir)
    .filter((f) => /^sprint-\d+\.md$/.test(f))
    .sort((a, b) => {
      const numA = parseInt(a.match(/(\d+)/)?.[1] ?? "0", 10);
      const numB = parseInt(b.match(/(\d+)/)?.[1] ?? "0", 10);
      return numA - numB;
    })) {
    const text = readFileSync(join(sprintsDir, f), "utf-8");
    const fm = parseFrontmatter(text);
    const name = f.replace(".md", "").replace(/-/g, " ");

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

    const sprintNumber = extractSprintNumber(name);
    const explicitCarryOver =
      /Issues not completed in this sprint were returned to the backlog/i.test(text) ||
      /moved into \[sprint-\d+\.md\]/i.test(text) ||
      /contains only the unfinished carry-over work/i.test(text);
    const issueIds = sprintNumber != null ? [...(issueIdsBySprint.get(sprintNumber) || new Set())].sort((a, b) => a - b) : [];
    const completedIssueIds =
      sprintNumber != null ? [...(completedIssueIdsBySprint.get(sprintNumber) || new Set())].sort((a, b) => a - b) : [];
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
