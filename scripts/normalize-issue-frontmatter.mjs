#!/usr/bin/env node
import { execFileSync } from "child_process";
import { readdirSync, readFileSync, writeFileSync } from "fs";
import { basename, join, resolve } from "path";

const ROOT = resolve(import.meta.dirname, "..");
const ISSUE_ROOT = join(ROOT, "plan/issues");
const SPRINT_ROOT = join(ROOT, "plan/issues/sprints");
const LEGACY_SPRINT_ROOT = join(ROOT, "plan/sprints");

const NON_ISSUE_BASENAMES = new Set([
  "1034-report.md",
  "82-findings.md",
  "backlog.md",
  "log.md",
  "analysis-2026-03-25.md",
  "sprint-1.md",
  "sprint-2.md",
  "sprint-3.md",
]);

const EXPLICIT_ISSUE_BASENAMES = new Set(["512-illegal-cast-closures.md"]);

const ORDERED_KEYS = [
  "id",
  "title",
  "status",
  "sprint",
  "created",
  "updated",
  "completed",
  "priority",
  "feasibility",
  "reasoning_effort",
  "task_type",
  "area",
  "language_feature",
  "goal",
  "renumbered_from",
  "parent",
  "depends_on",
  "blocked_by",
];

const STATUS_ALIASES = {
  backlog: "backlog",
  blocked: "blocked",
  done: "done",
  "in-progress": "in-progress",
  in_progress: "in-progress",
  open: "",
  ready: "ready",
  regression: "ready",
  review: "review",
  "in-review": "review",
  in_review: "review",
  "wont-fix": "wont-fix",
  wont_fix: "wont-fix",
};

const TASK_TYPE_ALIASES = {
  analysis: "analysis",
  bug: "bugfix",
  bugfix: "bugfix",
  docs: "docs",
  documentation: "docs",
  enhancement: "feature",
  feature: "feature",
  infrastructure: "infrastructure",
  infra: "infrastructure",
  investigation: "investigation",
  performance: "performance",
  planning: "planning",
  refactor: "refactor",
  test: "test",
  ui: "feature",
};

const CANONICAL_STATUSES = new Set(["backlog", "blocked", "done", "in-progress", "ready", "review", "wont-fix"]);
const CANONICAL_TASK_TYPES = new Set([
  "analysis",
  "bugfix",
  "docs",
  "feature",
  "infrastructure",
  "investigation",
  "performance",
  "planning",
  "refactor",
  "test",
]);

function issueIdFromBasename(name) {
  if (NON_ISSUE_BASENAMES.has(name)) return null;
  if (EXPLICIT_ISSUE_BASENAMES.has(name)) return name.match(/^(\d+[a-z]?)/i)?.[1].toLowerCase() || null;
  return name.match(/^(\d+[a-z]?)/i)?.[1].toLowerCase() || null;
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(file));
    else if (entry.isFile() && entry.name.endsWith(".md")) out.push(file);
  }
  return out.sort();
}

function isIssueFile(file) {
  const name = basename(file);
  if (NON_ISSUE_BASENAMES.has(name)) return false;
  if (EXPLICIT_ISSUE_BASENAMES.has(name)) return true;
  return /^\d+[a-z]?(?:-.+)?\.md$/i.test(name);
}

function parseFrontmatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return { blocks: [], body: text };
  const lines = match[1].split("\n");
  const blocks = [];
  let current = null;
  for (const line of lines) {
    if (/^[^\s][^:]*:/.test(line)) {
      if (current) blocks.push(current);
      current = { key: line.slice(0, line.indexOf(":")).trim(), lines: [line] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) blocks.push(current);
  return { blocks, body: text.slice(match[0].length) };
}

function frontmatterMap(blocks) {
  const map = new Map();
  for (const block of blocks) map.set(block.key, block.lines);
  return map;
}

function readScalar(blockLines) {
  if (!blockLines || blockLines.length === 0) return "";
  const line = blockLines[0];
  const idx = line.indexOf(":");
  if (idx < 0) return "";
  let value = line.slice(idx + 1).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return value;
}

function readArray(blockLines) {
  const raw = readScalar(blockLines);
  if (!raw) return [];
  if (!raw.startsWith("[") || !raw.endsWith("]")) return [];
  return raw
    .slice(1, -1)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function extractTitle(text) {
  const match =
    text.match(/^#\s+Issue\s+#?[\w-]+:\s+(.+)$/m) ||
    text.match(/^#\s+#?[\w-]+\s+[—-]+\s+(.+)$/m) ||
    text.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : "Untitled";
}

function extractId(file, text, existingId) {
  const fromExisting = String(existingId || "")
    .trim()
    .toLowerCase();
  if (/^\d+[a-z]?$/i.test(fromExisting)) return fromExisting;
  const fromName = issueIdFromBasename(basename(file));
  if (fromName) return fromName;
  const bodyMatch = text.match(/#\s+Issue\s+#(\d+[a-z]?)/i) || text.match(/#\s+#(\d+[a-z]?)\b/i);
  return bodyMatch ? bodyMatch[1].toLowerCase() : null;
}

function normalizeStatus(raw, folder, body) {
  const existing = String(raw || "")
    .trim()
    .toLowerCase();
  const bodyStatus = (body.match(/^##\s+Status:\s+(.+)$/im)?.[1] || "").trim().toLowerCase();
  const normalizedExisting = STATUS_ALIASES[existing];
  if (normalizedExisting) return normalizedExisting;
  const normalizedBody = STATUS_ALIASES[bodyStatus];
  if (normalizedBody) return normalizedBody;
  return "ready";
}

function normalizeSprint(raw) {
  const value = String(raw || "").trim();
  if (!value) return "";
  if (/^\d+$/.test(value)) return String(Number(value));
  const lower = value.toLowerCase();
  if (lower === "backlog") return "Backlog";
  if (["session", "dep-driven", "wave", "w6-wave1"].includes(lower)) return "0";
  if (/^sprint[- ]?\d+$/i.test(value)) return String(Number(value.match(/(\d+)/)?.[1]));
  return value;
}

function loadSprintMentions() {
  const mentions = new Map();
  const sprintFiles = [];
  for (const file of walk(SPRINT_ROOT)) {
    if (basename(file) !== "sprint.md") continue;
    const sprintNumber = file.match(/\/(\d+)\/sprint\.md$/)?.[1];
    if (!sprintNumber) continue;
    sprintFiles.push({ file, sprintNumber });
  }
  for (const file of walk(LEGACY_SPRINT_ROOT)) {
    if (!/^sprint-\d+/.test(basename(file))) continue;
    const sprintNumber = basename(file).match(/(\d+)/)?.[1];
    if (!sprintNumber) continue;
    sprintFiles.push({ file, sprintNumber });
  }
  for (const { file, sprintNumber } of sprintFiles) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/#(\d{1,4}[a-z]?)\b/gi)) {
      const id = match[1].toLowerCase();
      if (!mentions.has(id)) mentions.set(id, new Set());
      mentions.get(id).add(String(Number(sprintNumber)));
    }
  }
  return mentions;
}

function loadIssueHistory() {
  const history = new Map();
  const output = execFileSync(
    "git",
    [
      "log",
      "--find-renames",
      "--name-status",
      "--format=__DATE__%ad",
      "--date=short",
      "--reverse",
      "--",
      "plan/issues",
    ],
    { cwd: ROOT, encoding: "utf8" },
  );

  let currentDate = "";
  for (const line of output.split("\n")) {
    if (!line) continue;
    if (line.startsWith("__DATE__")) {
      currentDate = line.slice("__DATE__".length).trim();
      continue;
    }
    const parts = line.split("\t");
    const status = parts[0] || "";
    const paths = status.startsWith("R") ? parts.slice(1, 3) : parts.slice(1, 2);
    for (const relPath of paths) {
      const id = issueIdFromBasename(basename(relPath || ""));
      if (!id || !currentDate) continue;
      const record = history.get(id) || { created: "", updated: "", completed: "" };
      if (!record.created) record.created = currentDate;
      record.updated = currentDate;
      if (/(^|\/)(done|wont-fix)\//.test(relPath)) record.completed = currentDate;
      history.set(id, record);
    }
  }
  return history;
}

function inferSprint(existing, body, folder, issueId, mentions) {
  const normalized = normalizeSprint(existing);
  if (normalized) return normalized;

  const bodyMatches = [...body.matchAll(/\bSprint\s+(\d+)\b/g)].map((match) => String(Number(match[1])));
  const uniqueBodyMatches = [...new Set(bodyMatches)];
  if (uniqueBodyMatches.length === 1) return uniqueBodyMatches[0];

  const mentionValues = mentions.get(String(issueId).toLowerCase());
  if (mentionValues && mentionValues.size === 1) return [...mentionValues][0];

  if (folder === "backlog") return "Backlog";
  return "";
}

function inferCreated(existing, historyEntry) {
  return existing || historyEntry?.created || "";
}

function inferUpdated(existing, historyEntry) {
  return existing || historyEntry?.updated || "";
}

function inferCompleted(existing, status, historyEntry) {
  if (existing) return existing;
  if (!["done", "wont-fix"].includes(status)) return "";
  return historyEntry?.completed || historyEntry?.updated || "";
}

function normalizeTaskType(existing) {
  const value = String(existing || "")
    .trim()
    .toLowerCase();
  if (!value) return "";
  return TASK_TYPE_ALIASES[value] || value;
}

function serializeScalar(key, value) {
  if (value === "" || value == null) return "";
  if (key === "title") return `${key}: ${JSON.stringify(String(value))}`;
  if (key === "depends_on" && Array.isArray(value)) return `${key}: [${value.join(", ")}]`;
  return `${key}: ${value}`;
}

function rewriteFrontmatter(blocks, fields) {
  const extras = [];
  for (const block of blocks) {
    if (!ORDERED_KEYS.includes(block.key)) extras.push(block.lines.join("\n"));
  }
  const lines = ["---"];
  for (const key of ORDERED_KEYS) {
    const value = fields[key];
    if (value === "" || value == null || (Array.isArray(value) && value.length === 0)) continue;
    lines.push(serializeScalar(key, value));
  }
  for (const extra of extras) {
    if (!extra) continue;
    lines.push(extra);
  }
  lines.push("---");
  return `${lines.join("\n")}\n`;
}

function normalizeBodyStatus(body, status) {
  return body.replace(/^##\s+Status:\s+.+$/im, `## Status: ${status}`);
}

function recordIssueAudit(record, audit, historyEntry, folder) {
  const fields = record.fields;
  if (!fields.id) audit.missingId.push(record.file);
  if (!fields.title) audit.missingTitle.push(record.file);
  if (!fields.status) audit.missingStatus.push(record.file);
  if (!fields.sprint) audit.missingSprint.push(record.file);
  if (!fields.created) audit.missingCreated.push(record.file);
  if (["done", "wont-fix"].includes(fields.status) && !fields.completed) audit.missingCompleted.push(record.file);
  if (!fields.task_type) audit.missingTaskType.push(record.file);
  if (!fields.area) audit.missingArea.push(record.file);
  if (!fields.language_feature) audit.missingLanguageFeature.push(record.file);

  const rawStatus = String(record.rawStatus || "").trim();
  if (rawStatus && !CANONICAL_STATUSES.has(rawStatus)) audit.nonCanonicalStatus.push(`${record.file}: ${rawStatus}`);

  const rawTaskType = String(record.rawTaskType || "").trim();
  if (rawTaskType && !CANONICAL_TASK_TYPES.has(normalizeTaskType(rawTaskType))) {
    audit.nonCanonicalTaskType.push(`${record.file}: ${rawTaskType}`);
  }

  if (!historyEntry?.created && !fields.renumbered_from) audit.missingGitHistory.push(record.file);
}

function processFile(file, mentions, history, opts) {
  const text = readFileSync(file, "utf8");
  const { blocks, body } = parseFrontmatter(text);
  const map = frontmatterMap(blocks);
  const folder = file.split("/").at(-2) || "";
  const id = extractId(file, text, readScalar(map.get("id")));
  if (!id) return null;

  const historyEntry = history.get(id) || null;
  const title = readScalar(map.get("title")) || extractTitle(text);
  const status = normalizeStatus(readScalar(map.get("status")), folder, body);
  const sprint = inferSprint(readScalar(map.get("sprint")), body, folder, id, mentions);
  const created = inferCreated(readScalar(map.get("created")), historyEntry);
  const updated = inferUpdated(readScalar(map.get("updated")), historyEntry);
  const completed = inferCompleted(readScalar(map.get("completed")), status, historyEntry);
  const fields = {
    id,
    title,
    status,
    sprint,
    created,
    updated,
    completed,
    priority: readScalar(map.get("priority")),
    feasibility: readScalar(map.get("feasibility")),
    reasoning_effort: readScalar(map.get("reasoning_effort")),
    task_type: normalizeTaskType(readScalar(map.get("task_type"))),
    area: readScalar(map.get("area")),
    language_feature: readScalar(map.get("language_feature")),
    goal: readScalar(map.get("goal")),
    renumbered_from: readScalar(map.get("renumbered_from")),
    parent: readScalar(map.get("parent")),
    depends_on: readArray(map.get("depends_on")),
    blocked_by: readScalar(map.get("blocked_by")),
  };

  const nextFrontmatter = rewriteFrontmatter(blocks, fields);
  const nextBody = opts.syncBodyStatus ? normalizeBodyStatus(body, status) : body;
  const nextText = `${nextFrontmatter}${nextBody.replace(/^\n+/, "")}`;

  if (opts.write && nextText !== text) writeFileSync(file, nextText);

  return {
    file,
    changed: nextText !== text,
    fields,
    rawStatus: readScalar(map.get("status")),
    rawTaskType: readScalar(map.get("task_type")),
    historyEntry,
  };
}

function createAudit() {
  return {
    missingId: [],
    missingTitle: [],
    missingStatus: [],
    missingSprint: [],
    missingCreated: [],
    missingCompleted: [],
    missingTaskType: [],
    missingArea: [],
    missingLanguageFeature: [],
    nonCanonicalStatus: [],
    nonCanonicalTaskType: [],
    folderStatusMismatch: [],
    missingGitHistory: [],
    duplicateIds: [],
  };
}

function printAudit(audit, results) {
  console.log(`audited ${results.length} issue files`);
  const sections = [
    ["missing sprint", audit.missingSprint],
    ["missing created", audit.missingCreated],
    ["missing completed for done/wont-fix", audit.missingCompleted],
    ["missing task_type", audit.missingTaskType],
    ["missing area", audit.missingArea],
    ["missing language_feature", audit.missingLanguageFeature],
    ["non-canonical status", audit.nonCanonicalStatus],
    ["non-canonical task_type", audit.nonCanonicalTaskType],
    ["folder/status mismatch", audit.folderStatusMismatch],
    ["missing git history", audit.missingGitHistory],
    ["duplicate ids", audit.duplicateIds],
  ];
  for (const [label, entries] of sections) {
    console.log(`${label}: ${entries.length}`);
    for (const entry of entries.slice(0, 20)) console.log(`  - ${String(entry).replace(`${ROOT}/`, "")}`);
  }
}

function main() {
  const args = process.argv.slice(2);
  const opts = {
    write: args.includes("--write"),
    syncBodyStatus: args.includes("--sync-body-status"),
  };
  const targets = args.filter((arg) => !arg.startsWith("--")).map((arg) => resolve(ROOT, arg));

  const mentions = loadSprintMentions();
  const history = loadIssueHistory();
  const audit = createAudit();
  const results = [];
  const filesById = new Map();

  for (const file of walk(ISSUE_ROOT)) {
    if (!isIssueFile(file)) continue;
    if (targets.length > 0 && !targets.includes(file)) continue;
    const result = processFile(file, mentions, history, opts);
    if (!result) continue;
    recordIssueAudit(result, audit, result.historyEntry, result.folder);
    results.push(result);
    if (!filesById.has(result.fields.id)) filesById.set(result.fields.id, []);
    filesById.get(result.fields.id).push(result.file.replace(`${ROOT}/`, ""));
  }

  for (const [id, files] of filesById.entries()) {
    if (files.length > 1) audit.duplicateIds.push(`#${id}: ${files.join(", ")}`);
  }

  const changed = results.filter((result) => result.changed);
  console.log(`${opts.write ? "updated" : "would update"} ${changed.length} issue files out of ${results.length}`);
  for (const entry of changed.slice(0, 50)) console.log(entry.file.replace(`${ROOT}/`, ""));
  printAudit(audit, results);
}

main();
