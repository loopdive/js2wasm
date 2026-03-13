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
  files: Record<string, { new?: string[]; breaking?: string[] }> | string[];
  cluster?: string;
  compiler_errors?: number;
  test262_skip?: number;
  test262_fail?: number;
  test262_ce?: number;
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

/** Extract the largest compile-error count mentioned in the issue body */
function extractCompilerErrors(content: string): number | undefined {
  // Match patterns like "~681 compile errors", "At least 50 compile errors", "20 CE", "300 compiler errors"
  const patterns = [
    /~?(\d[\d,]*)\s+compil(?:e|er)\s+errors/gi,
    /at\s+least\s+(\d[\d,]*)\s+compil(?:e|er)\s+errors/gi,
    /(\d[\d,]*)\s+CE\b/g,
  ];
  let max = 0;
  for (const pat of patterns) {
    let m;
    while ((m = pat.exec(content)) !== null) {
      const n = parseInt(m[1].replace(/,/g, ""));
      if (n > max) max = n;
    }
  }
  return max > 0 ? max : undefined;
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
    const ce = extractCompilerErrors(content);
    const node: IssueNode = {
      id: num,
      title: getTitle(content),
      priority: fm.priority || (status === "done" ? "low" : "medium"),
      status,
      depends_on: Array.isArray(fm.depends_on) ? fm.depends_on : [],
      files: normalizeFiles(fm.files),
    };
    if (ce) node.compiler_errors = ce;
    if (fm.test262_skip) node.test262_skip = parseInt(String(fm.test262_skip)) || undefined;
    if (fm.test262_fail) node.test262_fail = parseInt(String(fm.test262_fail)) || undefined;
    if (fm.test262_ce) node.test262_ce = parseInt(String(fm.test262_ce)) || undefined;
    nodes.push(node);
  }
  return nodes;
}

/** Accept both old flat list and new nested map format */
function normalizeFiles(raw: any): Record<string, { new?: string[]; breaking?: string[] }> | string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw; // old format: ["src/codegen/expressions.ts"]
  if (typeof raw === "object") return raw; // new format: { "src/...": { new: [], breaking: [] } }
  return [];
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

// Cluster assignments from dependency-graph.md
const CLUSTERS: Record<number, string> = {};
const clusterMap: [string, number[]][] = [
  ["Diagnostics", [152, 242, 262, 265, 269, 270, 275, 276, 381, 383]],
  ["Dead code / Scanning", [321, 317, 319, 320, 318, 322]],
  ["Type coercion", [138, 139, 227, 228, 237, 295, 296, 299, 301, 308, 300, 324, 348]],
  ["Class / New", [234, 232, 238, 261, 260, 329, 334, 375, 377]],
  ["Property / Element", [140, 239, 263, 274, 281, 230, 305, 326, 337, 361, 362, 378]],
  ["Assignment / Destructuring", [142, 190, 243, 279, 283, 286, 306, 294, 325, 328, 379]],
  ["Generators / Yield", [241, 267, 287, 288]],
  ["Loops / Iteration", [250, 292, 268, 289, 297, 298, 353, 373]],
  ["Scope / Identifiers", [202, 146, 266, 331, 380]],
  ["Wasm validation", [277, 178, 315]],
  ["Test infrastructure", [271, 309, 310, 311, 312, 313, 314, 338, 360]],
  ["Built-ins / Runtime", [342, 344, 347, 349, 355, 359, 369, 384, 385]],
  ["Functions / Closures", [356, 364, 368, 382]],
  ["String / Template literals", [357, 363, 367, 372]],
  ["Modules / Imports", [332, 333, 371]],
  ["Standalone", [235, 244, 249, 254, 280, 290, 291, 293, 302, 303, 304, 307, 316, 229, 327, 335, 336, 341, 374, 386]],
];
for (const [name, ids] of clusterMap) {
  for (const id of ids) CLUSTERS[id] = name;
}
for (const n of nodes) {
  n.cluster = CLUSTERS[n.id] || "Unclustered";
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
