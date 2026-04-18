#!/usr/bin/env npx tsx
/**
 * Scans plan/issues/ and plan/goals/ and generates graph data for
 * public/issues-graph.html.
 *
 * Run: node --experimental-strip-types plan/generate-graph.ts
 * Output: public/graph-data.json
 */

import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "node:child_process";

type RawIssueStatus = "ready" | "in-progress" | "review" | "blocked" | "backlog" | "done" | "wont-fix" | "planning";

type GraphIssueStatus = "ready" | "blocked" | "done" | "backlog";

interface IssueNode {
  id: string;
  title: string;
  priority: "critical" | "high" | "medium" | "low";
  status: GraphIssueStatus;
  raw_status: string;
  sprint: string;
  depends_on: string[];
  files: Record<string, { new?: string[]; modify?: string[]; breaking?: string[] }> | string[];
  cluster?: string;
  goal?: string;
  compiler_errors?: number;
  test262_skip?: number;
  test262_fail?: number;
  test262_ce?: number;
}

interface GoalNode {
  id: string;
  title: string;
  status: "active" | "activatable" | "blocked" | "done";
  target: string;
  depends_on: string[];
  issues: string[];
  track?: string;
}

interface GraphData {
  nodes: IssueNode[];
  links: { source: string; target: string }[];
  goals: GoalNode[];
  goalIssueLinks: { goal: string; issue: string }[];
  goalDepLinks: { goal: string; issue: string }[];
  generated: string;
}

const ROOT = path.resolve(import.meta.dirname!, "..");
const ISSUES_DIR = path.join(ROOT, "plan", "issues");
const GOALS_DIR = path.join(ROOT, "plan", "goals");
const OUTPUT = path.join(ROOT, "public", "graph-data.json");
const NON_ISSUE_FILES = new Set([path.join(ISSUES_DIR, "SCHEMA.md"), path.join(ISSUES_DIR, "AUDIT-2026-04-14.md")]);

function git(args: string[]): string {
  return execFileSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function getTrackedMarkdownFiles(root: string): Set<string> | null {
  try {
    return new Set(
      git(["ls-files", root])
        .split("\n")
        .map((file) => file.trim())
        .filter((file) => file.endsWith(".md"))
        .map((file) => path.join(ROOT, file)),
    );
  } catch {
    return null;
  }
}

function getStableGeneratedAt(paths: string[]): string {
  const candidates = paths.filter((file) => fs.existsSync(file));
  if (!candidates.length) return "";
  try {
    return git(["log", "-1", "--no-merges", "--format=%aI", "--", ...candidates]);
  } catch {
    return "";
  }
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && entry.name.endsWith(".md")) out.push(full);
  }
  return out;
}

function isIssueFile(file: string): boolean {
  if (NON_ISSUE_FILES.has(file)) return false;
  return path.basename(file) !== "sprint.md";
}

function parseFrontmatter(content: string): Record<string, any> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};

  const data: Record<string, any> = {};
  let currentKey: string | null = null;

  for (const line of match[1].split("\n")) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (kv) {
      currentKey = kv[1];
      const raw = kv[2].trim();
      if (!raw) {
        data[currentKey] = [];
      } else if (raw.startsWith("[")) {
        try {
          data[currentKey] = JSON.parse(raw);
        } catch {
          data[currentKey] = raw.replace(/^"|"$/g, "");
        }
      } else {
        data[currentKey] = raw.replace(/^"|"$/g, "");
      }
      continue;
    }

    const li = line.match(/^\s*-\s*(.*)$/);
    if (li && currentKey && Array.isArray(data[currentKey])) {
      data[currentKey].push(li[1].replace(/^"|"$/g, ""));
    }
  }

  return data;
}

function getTitle(content: string, fm: Record<string, any>): string {
  if (typeof fm.title === "string" && fm.title.trim()) return fm.title.trim();
  const line = content.split("\n").find((l) => l.startsWith("# "));
  if (!line) return "Untitled";
  return line.replace(/^#\s*/, "").replace(/^(Issue\s*)?#?[\w-]+[\s:—-]*/, "");
}

function extractLargestCount(content: string, patterns: RegExp[]): number | undefined {
  let max = 0;
  for (const pat of patterns) {
    let m: RegExpExecArray | null;
    while ((m = pat.exec(content)) !== null) {
      const n = parseInt(m[1].replace(/,/g, ""), 10);
      if (n > max) max = n;
    }
  }
  return max > 0 ? max : undefined;
}

function extractCompilerErrors(content: string): number | undefined {
  return extractLargestCount(content, [
    /~?(\d[\d,]*)\s+compil(?:e|er)\s+errors/gi,
    /at\s+least\s+(\d[\d,]*)\s+compil(?:e|er)\s+errors/gi,
    /(\d[\d,]*)\s+CE\b/g,
  ]);
}

function normalizeFiles(
  raw: any,
): Record<string, { new?: string[]; modify?: string[]; breaking?: string[] }> | string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "object") return raw;
  return [];
}

function normalizePriority(value: unknown): IssueNode["priority"] {
  const v = String(value || "").toLowerCase();
  if (v === "critical" || v === "high" || v === "medium" || v === "low") return v;
  return "medium";
}

function normalizeRawStatus(value: unknown): RawIssueStatus {
  const v = String(value || "").toLowerCase();
  if (
    v === "ready" ||
    v === "in-progress" ||
    v === "review" ||
    v === "blocked" ||
    v === "backlog" ||
    v === "done" ||
    v === "wont-fix" ||
    v === "planning"
  ) {
    return v;
  }
  return "backlog";
}

function normalizeGraphStatus(raw: RawIssueStatus): GraphIssueStatus {
  if (raw === "blocked") return "blocked";
  if (raw === "backlog") return "backlog";
  if (raw === "done" || raw === "wont-fix") return "done";
  return "ready";
}

function parseIdList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((value) => String(value).trim()).filter(Boolean);
}

function scanIssues(): IssueNode[] {
  const nodes: IssueNode[] = [];
  const trackedFiles = getTrackedMarkdownFiles("plan/issues");
  for (const file of walk(ISSUES_DIR)
    .filter(isIssueFile)
    .filter((file) => !trackedFiles || trackedFiles.has(file))) {
    const content = fs.readFileSync(file, "utf8");
    const fm = parseFrontmatter(content);
    if (!fm.id && !fm.title && !fm.status) continue;

    const id = String(fm.id || path.basename(file, ".md")).trim();
    const rawStatus = normalizeRawStatus(fm.status);
    const node: IssueNode = {
      id,
      title: getTitle(content, fm),
      priority: normalizePriority(fm.priority),
      status: normalizeGraphStatus(rawStatus),
      raw_status: rawStatus,
      sprint: String(fm.sprint || ""),
      depends_on: parseIdList(fm.depends_on),
      files: normalizeFiles(fm.files),
      goal: String(fm.goal || "").trim() || undefined,
      cluster: String(fm.goal || "").trim() || (String(fm.sprint || "").trim() ? `sprint-${fm.sprint}` : "Unclustered"),
    };

    const ce = extractCompilerErrors(content);
    if (ce) node.compiler_errors = ce;
    if (fm.test262_skip) node.test262_skip = parseInt(String(fm.test262_skip), 10) || undefined;
    if (fm.test262_fail) node.test262_fail = parseInt(String(fm.test262_fail), 10) || undefined;
    if (fm.test262_ce) node.test262_ce = parseInt(String(fm.test262_ce), 10) || undefined;
    nodes.push(node);
  }
  return nodes;
}

function scanGoals(nodes: IssueNode[]): GoalNode[] {
  const issuesByGoal = new Map<string, string[]>();
  for (const node of nodes) {
    if (!node.goal) continue;
    if (!issuesByGoal.has(node.goal)) issuesByGoal.set(node.goal, []);
    issuesByGoal.get(node.goal)!.push(node.id);
  }

  const goals: GoalNode[] = [];
  for (const file of fs.readdirSync(GOALS_DIR)) {
    if (!file.endsWith(".md") || file === "goal-graph.md") continue;

    const id = file.replace(/\.md$/, "");
    const content = fs.readFileSync(path.join(GOALS_DIR, file), "utf8");
    const titleMatch = content.match(/^#\s+Goal:\s*(.+)$/m);
    const title = titleMatch ? titleMatch[1].trim() : id;

    let status: GoalNode["status"] = "blocked";
    const statusMatch = content.match(/\*\*Status\*\*:\s*(.+)$/im);
    if (statusMatch) {
      const s = statusMatch[1].trim().toLowerCase();
      if (s === "active") status = "active";
      else if (s === "activatable" || s === "partially") status = "activatable";
      else if (s === "done") status = "done";
    }

    const targetMatch = content.match(/\*\*Target\*\*:\s*(.+?)\.?\s*$/m);
    const target = targetMatch ? targetMatch[1].trim() : "";

    const dependsOn: string[] = [];
    const depsMatch = content.match(/\*\*Dependencies\*\*:\s*(.+?)$/m);
    if (depsMatch) {
      for (const dep of depsMatch[1].matchAll(/`([a-z][\w-]*)`/g)) {
        dependsOn.push(dep[1]);
      }
    }

    const trackMatch = content.match(/\*\*Track\*\*:\s*(.+)$/im);
    const track = trackMatch ? trackMatch[1].trim().toLowerCase() : undefined;

    goals.push({
      id,
      title,
      status,
      target,
      depends_on: dependsOn,
      issues: (issuesByGoal.get(id) || []).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
      ...(track ? { track } : {}),
    });
  }
  return goals;
}

const nodes = scanIssues();
const nodeIds = new Set(nodes.map((node) => node.id));
const goals = scanGoals(nodes);
const goalIds = new Set(goals.map((goal) => goal.id));

const links: GraphData["links"] = [];
for (const node of nodes) {
  for (const dep of node.depends_on) {
    if (nodeIds.has(dep)) {
      links.push({ source: dep, target: node.id });
    }
  }
}

const goalIssueLinks: GraphData["goalIssueLinks"] = [];
for (const goal of goals) {
  for (const issueId of goal.issues) {
    if (nodeIds.has(issueId)) {
      goalIssueLinks.push({ goal: goal.id, issue: issueId });
    }
  }
}

const goalDepLinks: GraphData["goalDepLinks"] = [];
for (const goal of goals) {
  for (const dep of goal.depends_on) {
    if (!goalIds.has(dep)) continue;
    for (const issueId of goal.issues) {
      if (nodeIds.has(issueId)) {
        goalDepLinks.push({ goal: dep, issue: issueId });
      }
    }
  }
}

const data: GraphData = {
  nodes: nodes.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true })),
  links,
  goals: goals.sort((a, b) => a.id.localeCompare(b.id)),
  goalIssueLinks,
  goalDepLinks,
  generated: getStableGeneratedAt([...walk(ISSUES_DIR), ...walk(GOALS_DIR)]),
};

fs.writeFileSync(OUTPUT, JSON.stringify(data, null, 2));
console.log(
  `Generated ${OUTPUT}: ${data.nodes.length} issues, ${data.goals.length} goals, ${data.links.length} issue links, ${data.goalIssueLinks.length} goal links, ${data.goalDepLinks.length} goal-dep links`,
);
