#!/usr/bin/env npx tsx
/**
 * Scans plan/issues/ folders and generates a JSON graph for the HTML visualizer.
 * Run: npx tsx plan/generate-graph.ts
 * Output: plan/graph-data.json
 */

import * as fs from "fs";
import * as path from "path";

interface IssueNode {
  id: number;
  title: string;
  priority: "critical" | "high" | "medium" | "low";
  status: "ready" | "blocked" | "done" | "backlog" | "wont-fix";
  depends_on: number[];
  files: string[];
  cluster?: string;
}

interface GraphData {
  nodes: IssueNode[];
  links: { source: number; target: number }[];
  generated: string;
}

const PLAN_DIR = path.join(import.meta.dirname!, "issues");

function parseFrontmatter(content: string): Record<string, any> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const fm: Record<string, any> = {};
  const lines = match[1].split("\n");
  let currentKey = "";
  let currentArray: string[] | null = null;
  for (const line of lines) {
    // YAML list item: "  - value"
    if (currentArray !== null && /^\s+-\s+/.test(line)) {
      currentArray.push(line.replace(/^\s+-\s+/, "").trim());
      continue;
    }
    // End of array
    if (currentArray !== null) {
      fm[currentKey] = currentArray;
      currentArray = null;
    }
    // Key: value or Key: [inline array]
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) {
      const [, key, val] = kv;
      currentKey = key;
      if (!val || val.trim() === "") {
        // Start of YAML block array
        currentArray = [];
      } else if (val.startsWith("[")) {
        try { fm[key] = JSON.parse(val); } catch { fm[key] = val; }
      } else {
        fm[key] = val.trim();
      }
    }
  }
  if (currentArray !== null) fm[currentKey] = currentArray;
  return fm;
}

function getTitle(content: string): string {
  const line = content.split("\n").find((l) => l.startsWith("# "));
  if (!line) return "Untitled";
  return line.replace(/^#\s*/, "").replace(/^(Issue\s*)?#?\d+[\s:—-]*/, "");
}

function scanFolder(
  folder: string,
  status: IssueNode["status"]
): IssueNode[] {
  const dir = path.join(PLAN_DIR, folder);
  if (!fs.existsSync(dir)) return [];
  const nodes: IssueNode[] = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".md")) continue;
    const num = parseInt(file);
    if (isNaN(num)) continue;
    const content = fs.readFileSync(path.join(dir, file), "utf-8");
    const fm = parseFrontmatter(content);
    nodes.push({
      id: num,
      title: getTitle(content),
      priority: fm.priority || (status === "done" ? "low" : "medium"),
      status,
      depends_on: Array.isArray(fm.depends_on) ? fm.depends_on : [],
      files: Array.isArray(fm.files) ? fm.files : [],
    });
  }
  return nodes;
}

// Scan all folders
const nodes: IssueNode[] = [
  ...scanFolder("ready", "ready"),
  ...scanFolder("blocked", "blocked"),
  ...scanFolder("backlog", "backlog"),
  ...scanFolder("wont-fix", "wont-fix"),
  // Only include done issues that are dependencies of open issues
];

// Find done issues referenced by open issues
const openDeps = new Set<number>();
for (const n of nodes) {
  for (const d of n.depends_on) {
    if (!nodes.find((x) => x.id === d)) {
      openDeps.add(d);
    }
  }
}
// Add referenced done issues as context
for (const doneId of openDeps) {
  const file = path.join(PLAN_DIR, "done", `${doneId}.md`);
  if (fs.existsSync(file)) {
    const content = fs.readFileSync(file, "utf-8");
    nodes.push({
      id: doneId,
      title: getTitle(content),
      priority: "low",
      status: "done",
      depends_on: [],
      files: [],
    });
  }
}

// Build links from depends_on
const links: GraphData["links"] = [];
const nodeIds = new Set(nodes.map((n) => n.id));
for (const n of nodes) {
  for (const dep of n.depends_on) {
    if (nodeIds.has(dep)) {
      links.push({ source: dep, target: n.id });
    }
  }
}

const data: GraphData = {
  nodes: nodes.sort((a, b) => a.id - b.id),
  links,
  generated: new Date().toISOString(),
};

const outPath = path.join(import.meta.dirname!, "graph-data.json");
fs.writeFileSync(outPath, JSON.stringify(data, null, 2));
console.log(
  `Generated ${outPath}: ${data.nodes.length} nodes, ${data.links.length} links`
);
