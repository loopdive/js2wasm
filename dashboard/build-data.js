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

function extractIssueIds(text) {
  const ids = new Set();
  const queueSection = text.match(/## Task queue[\s\S]*?(?=\n## |\s*$)/i)?.[0];
  if (!queueSection) return [];
  for (const line of queueSection.split("\n")) {
    if (!line.trim().startsWith("|")) continue;
    if (/^\|\s*-/.test(line)) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((s) => s.trim());
    if (cells.length < 2) continue;
    const m = cells[1].match(/#(\d{2,4})\b/);
    if (m) ids.add(parseInt(m[1], 10));
  }
  return [...ids].sort((a, b) => a - b);
}

function extractIssueBullets(text) {
  const issueSection = text.match(/## Issues[\s\S]*?(?=\n## |\s*$)/i)?.[0];
  if (!issueSection) return [];
  const rows = [];
  for (const line of issueSection.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("-")) continue;
    const ids = [...trimmed.matchAll(/#(\d{2,4})\b/g)].map((m) => parseInt(m[1], 10));
    if (!ids.length) continue;
    rows.push({ line: trimmed, ids });
  }
  return rows;
}

function extractListedIssueIds(text) {
  const ids = new Set();
  for (const row of extractIssueBullets(text)) {
    for (const id of row.ids) ids.add(id);
  }
  return [...ids].sort((a, b) => a - b);
}

function extractCompletedIssueIds(text) {
  const ids = new Set();
  for (const line of text.split("\n")) {
    if (!line.trim().startsWith("|")) continue;
    if (/^\|\s*-/.test(line)) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((s) => s.trim());
    if (cells.length < 2) continue;
    const issueCell = cells.find((cell) => /#\d{2,4}\b/.test(cell));
    if (!issueCell) continue;
    const issueMatch = issueCell.match(/#(\d{2,4})\b/);
    if (!issueMatch) continue;
    const tail = cells.slice(cells.indexOf(issueCell) + 1).join(" | ");
    if (/\b(done|merged|complete(?:d)?|verified fixed)\b/i.test(tail)) {
      ids.add(parseInt(issueMatch[1], 10));
    }
  }
  return [...ids].sort((a, b) => a - b);
}

function mergeUniqueIds(...lists) {
  const ids = new Set();
  for (const list of lists) {
    for (const id of list || []) ids.add(id);
  }
  return [...ids].sort((a, b) => a - b);
}

function deriveHistoricalCompletedIssueIds(text, issueIds) {
  const doneIds = new Set(
    readdirSync(join(ROOT, "plan/issues/done"))
      .filter((f) => /^[0-9]+\.md$/.test(f))
      .map((f) => parseInt(f.replace(".md", ""), 10)),
  );
  const createdIds = new Set();
  for (const row of extractIssueBullets(text)) {
    if (!/\bcreated\b/i.test(row.line)) continue;
    for (const id of row.ids) createdIds.add(id);
  }
  return issueIds.filter((id) => doneIds.has(id) && !createdIds.has(id));
}

function loadDoneSprintMap() {
  const p = join(ROOT, "plan/issues/done/log.md");
  const bySprint = new Map();
  if (!existsSync(p)) return bySprint;
  const text = readFileSync(p, "utf-8");
  for (const line of text.split("\n")) {
    const m = line.match(/^\|\s*([0-9]+)\s*\|\s*[^|]*\|\s*[^|]*\|\s*Sprint[- ]?(\d+)\s*\|/i);
    if (!m) continue;
    const id = parseInt(m[1], 10);
    const sprint = parseInt(m[2], 10);
    if (!bySprint.has(sprint)) bySprint.set(sprint, []);
    bySprint.get(sprint).push(id);
  }
  return bySprint;
}

// ── Load issues ──────────────────────────────────────────────
function loadIssuesFromDir(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      const text = readFileSync(join(dir, f), "utf-8");
      const fm = parseFrontmatter(text);
      const id = f.replace(".md", "");
      const title = fm.title || extractTitle(text);
      const status = fm.status || null;
      return {
        id,
        title,
        priority: fm.priority || "medium",
        feasibility: fm.feasibility || "",
        depends_on: fm.depends_on || [],
        goal: fm.goal || "",
        status,
      };
    })
    .sort((a, b) => Number(b.id) - Number(a.id)); // newest first
}

const issues = {
  blocked: loadIssuesFromDir(join(ROOT, "plan/issues/blocked")),
  ready: loadIssuesFromDir(join(ROOT, "plan/issues/ready")),
  inprogress: [], // in-progress issues are in ready/ with status: in-progress
  done: loadIssuesFromDir(join(ROOT, "plan/issues/done")),
};

// Split ready into ready vs in-progress based on frontmatter status
const ready = [];
for (const iss of issues.ready) {
  if (iss.status === "in-progress" || iss.status === "in_progress") {
    issues.inprogress.push(iss);
  } else {
    ready.push(iss);
  }
}
issues.ready = ready;

writeFileSync(join(OUT, "issues.json"), JSON.stringify(issues, null, 2));
console.log(
  `Issues: ${issues.blocked.length} blocked, ${issues.ready.length} ready, ${issues.inprogress.length} in-progress, ${issues.done.length} done`,
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
const doneBySprint = loadDoneSprintMap();
if (existsSync(sprintsDir)) {
  for (const f of readdirSync(sprintsDir)
    .filter((f) => f.endsWith(".md"))
    .sort((a, b) => {
      const numA = parseInt(a.match(/(\d+)/)?.[1] ?? "0", 10);
      const numB = parseInt(b.match(/(\d+)/)?.[1] ?? "0", 10);
      return numA - numB;
    })) {
    const text = readFileSync(join(sprintsDir, f), "utf-8");
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
    const issueIds = mergeUniqueIds(extractIssueIds(text), extractListedIssueIds(text));
    const completedFromLog = sprintNumber != null ? doneBySprint.get(sprintNumber) || [] : [];
    const completedFromSprint = extractCompletedIssueIds(text);
    const completedFromHistory = explicitCarryOver ? deriveHistoricalCompletedIssueIds(text, issueIds) : [];
    const completedIssueIds = mergeUniqueIds(completedFromLog, completedFromSprint, completedFromHistory);
    sprints.push({
      name,
      sprintNumber,
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

console.log("Done. Open dashboard/index.html in a browser.");
