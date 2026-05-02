#!/usr/bin/env node
// scripts/update-issues.mjs
// Single-pass issue maintenance pipeline.
//
// In one file walk:
//   1. Normalize frontmatter (sprint stripped, status/task_type canonicalized, dates inferred)
//   2. Sync required_by as reverse of depends_on
//   3. Generate plan/log/sprints/index.md  (sprint history + current sprint active issues)
//   4. Generate plan/issues/backlog/index.md
//   5. Generate plan/issues/wont-fix/index.md
//
// Usage:
//   node scripts/update-issues.mjs              # full pass
//   node scripts/update-issues.mjs --check      # audit only, no writes
//   node scripts/update-issues.mjs --indexes-only  # skip normalize/sync, only regen indexes
//   node scripts/update-issues.mjs [file...]    # operate on specific files only (normalize only)

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, basename, resolve, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ISSUE_ROOT = join(ROOT, "plan", "issues");
const SPRINTS_ROOT = join(ISSUE_ROOT, "sprints");
const BACKLOG_ROOT = join(ISSUE_ROOT, "backlog");
const WONTFIX_ROOT = join(ISSUE_ROOT, "wont-fix");
const SPRINTS_LOG = join(ROOT, "plan", "log", "sprints");

const argv = process.argv.slice(2);
const CHECK = argv.includes("--check");
const INDEXES_ONLY = argv.includes("--indexes-only");
const SYNC_BODY_STATUS = argv.includes("--sync-body-status");
const targets = argv.filter((a) => !a.startsWith("--")).map((a) => resolve(ROOT, a));

// ── Schema ──────────────────────────────────────────────────────────────────

const NON_ISSUE_BASENAMES = new Set([
  "1034-report.md",
  "82-findings.md",
  "backlog.md",
  "index.md",
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
  "required_by",
  "blocked_by",
];

const DROPPED_KEYS = new Set(["sprint"]);

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
  ci: "infrastructure",
  implementation: "feature",
};

const PRIORITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3, "": 4 };

// ── File helpers ─────────────────────────────────────────────────────────────

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && entry.name.endsWith(".md")) out.push(full);
  }
  return out.sort();
}

function isIssueFile(file) {
  const name = basename(file);
  if (NON_ISSUE_BASENAMES.has(name)) return false;
  if (EXPLICIT_ISSUE_BASENAMES.has(name)) return true;
  if (name === "sprint.md") return false;
  // Accept: 1234.md  1234a.md  1234-slug.md  1234__slug_title.md
  return /^\d+[a-z]?(?:[-_].+)?\.md$/i.test(name);
}

function sprintFromPath(file) {
  const m = file.match(/\/sprints\/(\d+)\//);
  if (m) return m[1];
  if (/\/backlog\//.test(file)) return "backlog";
  if (/\/wont-fix\//.test(file)) return "wont-fix";
  return "";
}

function relPath(file) {
  return relative(ROOT, file);
}

// ── Frontmatter parsing ──────────────────────────────────────────────────────

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
  for (const b of blocks) map.set(b.key, b.lines);
  return map;
}

function readScalar(blockLines) {
  if (!blockLines || blockLines.length === 0) return "";
  const line = blockLines[0];
  const idx = line.indexOf(":");
  if (idx < 0) return "";
  let value = line.slice(idx + 1).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    value = value.slice(1, -1);
  return value;
}

function readArray(blockLines) {
  const raw = readScalar(blockLines);
  if (!raw || !raw.startsWith("[") || !raw.endsWith("]")) return [];
  return raw
    .slice(1, -1)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// ── Frontmatter normalization ────────────────────────────────────────────────

function issueIdFromBasename(name) {
  if (NON_ISSUE_BASENAMES.has(name)) return null;
  return name.match(/^(\d+[a-z]?)/i)?.[1].toLowerCase() || null;
}

function extractId(file, text, existingId) {
  const fromExisting = String(existingId || "")
    .trim()
    .toLowerCase();
  if (/^\d+[a-z]?$/i.test(fromExisting)) return fromExisting;
  const fromName = issueIdFromBasename(basename(file));
  if (fromName) return fromName;
  const m = text.match(/#\s+Issue\s+#(\d+[a-z]?)/i) || text.match(/#\s+#(\d+[a-z]?)\b/i);
  return m ? m[1].toLowerCase() : null;
}

function extractTitle(text) {
  const m =
    text.match(/^#\s+Issue\s+#?[\w-]+:\s+(.+)$/m) ||
    text.match(/^#\s+#?[\w-]+\s+[—-]+\s+(.+)$/m) ||
    text.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : "Untitled";
}

function normalizeStatus(raw, body) {
  const existing = String(raw || "")
    .trim()
    .toLowerCase();
  const bodyStatus = (body.match(/^##\s+Status:\s+(.+)$/im)?.[1] || "").trim().toLowerCase();
  return STATUS_ALIASES[existing] ?? STATUS_ALIASES[bodyStatus] ?? "ready";
}

function normalizeTaskType(existing) {
  const v = String(existing || "")
    .trim()
    .toLowerCase();
  return TASK_TYPE_ALIASES[v] || v || "";
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
      currentDate = line.slice(8).trim();
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

function serializeScalar(key, value) {
  if (value === "" || value == null) return "";
  if (key === "title") return `${key}: ${JSON.stringify(String(value))}`;
  if ((key === "depends_on" || key === "required_by") && Array.isArray(value)) return `${key}: [${value.join(", ")}]`;
  return `${key}: ${value}`;
}

function rewriteFrontmatter(blocks, fields) {
  const extras = [];
  for (const b of blocks) {
    if (!ORDERED_KEYS.includes(b.key) && !DROPPED_KEYS.has(b.key)) extras.push(b.lines.join("\n"));
  }
  const lines = ["---"];
  for (const key of ORDERED_KEYS) {
    const value = fields[key];
    if (value === "" || value == null || (Array.isArray(value) && value.length === 0)) continue;
    lines.push(serializeScalar(key, value));
  }
  for (const extra of extras) {
    if (extra) lines.push(extra);
  }
  lines.push("---");
  return `${lines.join("\n")}\n`;
}

function normalizeBodyStatus(body, status) {
  return body.replace(/^##\s+Status:\s+.+$/im, `## Status: ${status}`);
}

// ── Main processing pass ─────────────────────────────────────────────────────

function processAllIssues() {
  const history = INDEXES_ONLY ? new Map() : loadIssueHistory();
  const allFiles = walk(ISSUE_ROOT).filter(isIssueFile);
  const records = [];
  const allById = new Map();

  for (const file of allFiles) {
    if (targets.length > 0 && !targets.includes(file)) continue;
    const originalText = readFileSync(file, "utf8");
    const { blocks, body } = parseFrontmatter(originalText);
    const map = frontmatterMap(blocks);
    const id = extractId(file, originalText, readScalar(map.get("id")));
    if (!id) continue;

    const historyEntry = history.get(id) || null;
    const rawStatus = readScalar(map.get("status"));
    const rawTaskType = readScalar(map.get("task_type"));
    const status = normalizeStatus(rawStatus, body);
    const created = readScalar(map.get("created")) || historyEntry?.created || "";
    const updated = readScalar(map.get("updated")) || historyEntry?.updated || "";
    let completed = readScalar(map.get("completed"));
    if (!completed && ["done", "wont-fix"].includes(status))
      completed = historyEntry?.completed || historyEntry?.updated || "";

    const fields = {
      id,
      title: readScalar(map.get("title")) || extractTitle(originalText),
      status,
      created,
      updated,
      completed,
      priority: readScalar(map.get("priority")),
      feasibility: readScalar(map.get("feasibility")),
      reasoning_effort: readScalar(map.get("reasoning_effort")),
      task_type: normalizeTaskType(rawTaskType),
      area: readScalar(map.get("area")),
      language_feature: readScalar(map.get("language_feature")),
      goal: readScalar(map.get("goal")),
      renumbered_from: readScalar(map.get("renumbered_from")),
      parent: readScalar(map.get("parent")),
      depends_on: readArray(map.get("depends_on")),
      required_by: readArray(map.get("required_by")),
      blocked_by: readScalar(map.get("blocked_by")),
    };

    const sprint = sprintFromPath(file);
    const sprintNum = sprint && sprint !== "backlog" && sprint !== "wont-fix" ? parseInt(sprint, 10) : null;

    const record = { file, originalText, blocks, body, fields, sprint, sprintNum };
    records.push(record);

    const key = id.toLowerCase();
    if (!allById.has(key)) allById.set(key, []);
    allById.get(key).push(record);
  }

  // Canonical record per id (first found)
  const byId = new Map();
  for (const [id, entries] of allById) byId.set(id, entries[0]);

  // Build reverse dependency index
  const reverseIndex = new Map();
  for (const [id, rec] of byId) {
    for (const dep of rec.fields.depends_on) {
      const depKey = String(dep).trim().toLowerCase();
      if (!reverseIndex.has(depKey)) reverseIndex.set(depKey, new Set());
      reverseIndex.get(depKey).add(id);
    }
  }

  // Finalize: inject required_by + produce final text for each canonical record
  let issueFilesUpdated = 0;
  for (const [id, rec] of byId) {
    if (INDEXES_ONLY) continue;
    if (targets.length > 0 && !targets.includes(rec.file)) continue;

    const newRequiredBy = [...(reverseIndex.get(id) || [])].sort((a, b) =>
      String(a).localeCompare(String(b), undefined, { numeric: true }),
    );
    rec.fields.required_by = newRequiredBy;

    const nextFrontmatter = rewriteFrontmatter(rec.blocks, rec.fields);
    const nextBody = SYNC_BODY_STATUS ? normalizeBodyStatus(rec.body, rec.fields.status) : rec.body;
    const nextText = `${nextFrontmatter}${nextBody.replace(/^\n+/, "")}`;

    if (!CHECK && nextText !== rec.originalText) {
      writeFileSync(rec.file, nextText);
      issueFilesUpdated++;
    }
    rec.finalText = nextText;
  }

  return { records, byId, allById, reverseIndex, issueFilesUpdated };
}

// ── Index generation ─────────────────────────────────────────────────────────

const TODAY = new Date().toISOString().slice(0, 10);

function prioritySort(a, b) {
  const pa = PRIORITY_ORDER[a.fields.priority?.toLowerCase() || ""] ?? 4;
  const pb = PRIORITY_ORDER[b.fields.priority?.toLowerCase() || ""] ?? 4;
  return pa !== pb ? pa - pb : String(a.fields.id).localeCompare(String(b.fields.id), undefined, { numeric: true });
}

function completedSort(a, b) {
  const ca = a.fields.completed || "0000-00-00";
  const cb = b.fields.completed || "0000-00-00";
  return cb.localeCompare(ca) || String(b.fields.id).localeCompare(String(a.fields.id), undefined, { numeric: true });
}

function issueLink(rec, baseDir) {
  const rel = relative(baseDir, rec.file);
  return `[#${rec.fields.id}](${rel})`;
}

function truncate(s, max = 70) {
  return s && s.length > max ? s.slice(0, max - 1) + "…" : s || "";
}

// ── plan/log/sprints/index.md ────────────────────────────────────────────────

function generateSprintsIndex(records) {
  const baseDir = SPRINTS_LOG;

  // Separate sprint issues from backlog/wont-fix
  const sprintRecords = records.filter((r) => r.sprintNum !== null);

  // Group by sprint number
  const bySprint = new Map();
  for (const rec of sprintRecords) {
    if (!bySprint.has(rec.sprintNum)) bySprint.set(rec.sprintNum, []);
    bySprint.get(rec.sprintNum).push(rec);
  }

  // Sort sprints descending
  const sprintNums = [...bySprint.keys()].sort((a, b) => b - a);

  const lines = [
    "# Sprint Issues",
    "",
    `_Auto-generated by \`scripts/update-issues.mjs\` on ${TODAY}. Do not edit manually._`,
    "",
  ];

  const maxSprint = sprintNums[0] ?? 0;

  for (const num of sprintNums) {
    const isCurrentSprint = num === maxSprint;
    const allRecs = bySprint.get(num);

    // Read sprint.md for metadata if available
    const sprintMd = join(SPRINTS_ROOT, String(num), "sprint.md");
    let sprintMeta = "";
    try {
      const text = readFileSync(sprintMd, "utf8");
      const dateMatch = text.match(/\*\*Date\*\*:\s*(.+)/);
      const baselineMatch = text.match(/\*\*Baseline\*\*:\s*(.+)/);
      if (dateMatch) sprintMeta += `\n**Date**: ${dateMatch[1].trim()}`;
      if (baselineMatch) sprintMeta += `  \n**Baseline**: ${baselineMatch[1].trim()}`;
    } catch {}

    const label = isCurrentSprint ? `Sprint ${num} — Current` : `Sprint ${num}`;
    lines.push(`## ${label}`, "");
    if (sprintMeta) {
      lines.push(sprintMeta.trim(), "");
    }

    if (isCurrentSprint) {
      // Active issues (not done)
      const active = allRecs.filter((r) => !["done", "wont-fix"].includes(r.fields.status)).sort(prioritySort);

      if (active.length > 0) {
        lines.push("### Active", "");
        lines.push("| Status | # | Title | Priority | Area |");
        lines.push("|--------|---|-------|----------|------|");
        for (const rec of active) {
          const link = issueLink(rec, baseDir);
          const status = rec.fields.status || "ready";
          const area = rec.fields.area || "";
          lines.push(
            `| ${status} | ${link} | ${truncate(rec.fields.title, 65)} | ${rec.fields.priority || ""} | ${area} |`,
          );
        }
        lines.push("");
      }
    }

    // Done issues
    const done = allRecs.filter((r) => r.fields.status === "done").sort(completedSort);
    if (done.length > 0) {
      const header = isCurrentSprint ? "### Done" : `### Done (${done.length})`;
      lines.push(header, "");
      lines.push("| Completed | # | Title | Area | Type |");
      lines.push("|-----------|---|-------|------|------|");
      for (const rec of done) {
        const link = issueLink(rec, baseDir);
        const area = rec.fields.area || "";
        const taskType = rec.fields.task_type || "";
        lines.push(
          `| ${rec.fields.completed || ""} | ${link} | ${truncate(rec.fields.title, 65)} | ${area} | ${taskType} |`,
        );
      }
      lines.push("");
    }

    // Wont-fix issues in this sprint
    const wontFix = allRecs.filter((r) => r.fields.status === "wont-fix").sort(completedSort);
    if (wontFix.length > 0) {
      lines.push(`### Won't Fix (${wontFix.length})`, "");
      lines.push("| # | Title |");
      lines.push("|---|-------|");
      for (const rec of wontFix) {
        const link = issueLink(rec, baseDir);
        lines.push(`| ${link} | ${truncate(rec.fields.title, 80)} |`);
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

// ── plan/issues/backlog/index.md ─────────────────────────────────────────────

function generateBacklogIndex(records) {
  const backlogRecs = records.filter((r) => r.sprint === "backlog");

  const ready = backlogRecs.filter((r) => r.fields.status === "ready").sort(prioritySort);
  const blocked = backlogRecs.filter((r) => r.fields.status === "blocked").sort(prioritySort);
  const backlog = backlogRecs.filter((r) => r.fields.status === "backlog").sort(prioritySort);
  const done = backlogRecs.filter((r) => ["done", "wont-fix"].includes(r.fields.status)).sort(completedSort);

  const lines = [
    "# Backlog",
    "",
    `_Auto-generated by \`scripts/update-issues.mjs\` on ${TODAY}. Do not edit manually._`,
    "",
    `**${ready.length} ready · ${blocked.length} blocked · ${backlog.length} backlog**`,
    "",
  ];

  function issueRow(rec) {
    const link = `[#${rec.fields.id}](${basename(rec.file)})`;
    const deps = rec.fields.depends_on.length ? rec.fields.depends_on.map((d) => `#${d}`).join(", ") : "";
    return `| ${link} | ${truncate(rec.fields.title, 65)} | ${rec.fields.priority || ""} | ${rec.fields.feasibility || ""} | ${rec.fields.goal || ""} | ${deps} |`;
  }

  const tableHeader = [
    "| # | Title | Priority | Feasibility | Goal | Depends On |",
    "|---|-------|----------|-------------|------|------------|",
  ];

  if (ready.length > 0) {
    lines.push(`## Ready (${ready.length})`, "", ...tableHeader);
    for (const rec of ready) lines.push(issueRow(rec));
    lines.push("");
  }

  if (blocked.length > 0) {
    lines.push(`## Blocked (${blocked.length})`, "", ...tableHeader);
    for (const rec of blocked) lines.push(issueRow(rec));
    lines.push("");
  }

  if (backlog.length > 0) {
    lines.push(`## Backlog (${backlog.length})`, "", ...tableHeader);
    for (const rec of backlog) lines.push(issueRow(rec));
    lines.push("");
  }

  if (done.length > 0) {
    lines.push(`## Completed (${done.length})`, "");
    lines.push("| Completed | # | Title |");
    lines.push("|-----------|---|-------|");
    for (const rec of done) {
      const link = `[#${rec.fields.id}](${basename(rec.file)})`;
      lines.push(`| ${rec.fields.completed || ""} | ${link} | ${truncate(rec.fields.title, 70)} |`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ── plan/issues/wont-fix/index.md ───────────────────────────────────────────

function generateWontFixIndex(records) {
  const wontFixRecs = records
    .filter((r) => r.sprint === "wont-fix" || r.fields.status === "wont-fix")
    .sort((a, b) => String(b.fields.id).localeCompare(String(a.fields.id), undefined, { numeric: true }));

  const lines = [
    "# Won't Fix",
    "",
    `_Auto-generated by \`scripts/update-issues.mjs\` on ${TODAY}. Do not edit manually._`,
    "",
    `**${wontFixRecs.length} issues**`,
    "",
    "| # | Title | Closed | Reason |",
    "|---|-------|--------|--------|",
  ];

  for (const rec of wontFixRecs) {
    const link = `[#${rec.fields.id}](${basename(rec.file)})`;
    // Look for closed_reason in the raw text
    const reasonMatch = rec.originalText.match(/^closed_reason:\s*["']?(.+?)["']?\s*$/m);
    const reason = reasonMatch ? truncate(reasonMatch[1], 60) : "";
    const closed = rec.fields.completed || "";
    lines.push(`| ${link} | ${truncate(rec.fields.title, 65)} | ${closed} | ${reason} |`);
  }
  lines.push("");

  return lines.join("\n");
}

// ── Write helper ─────────────────────────────────────────────────────────────

function writeIfChanged(file, content) {
  let existing = "";
  try {
    existing = readFileSync(file, "utf8");
  } catch {}
  if (content === existing) return false;
  if (!CHECK) writeFileSync(file, content, "utf8");
  return true;
}

// ── Main ─────────────────────────────────────────────────────────────────────

const { records, byId, allById, reverseIndex, issueFilesUpdated } = processAllIssues();

const allRecords = [...byId.values()];

// Audit
const duplicates = [...allById.entries()].filter(([, e]) => e.length > 1);

// Filename-prefix ↔ frontmatter id mismatch: e.g. 1234.md with id: 1235
const idMismatches = [];
for (const [, rec] of byId) {
  const namePrefix = issueIdFromBasename(basename(rec.file));
  if (namePrefix && namePrefix !== rec.fields.id) {
    idMismatches.push({ file: relPath(rec.file), filename: namePrefix, frontmatter: rec.fields.id });
  }
}

const dangling = [];
const resolved = [];
for (const [, rec] of byId) {
  for (const dep of rec.fields.depends_on) {
    const depKey = String(dep).trim().toLowerCase();
    if (!byId.has(depKey)) dangling.push({ from: relPath(rec.file), dep });
    else if (["done", "wont-fix"].includes(byId.get(depKey).fields.status))
      resolved.push({ from: relPath(rec.file), dep, depStatus: byId.get(depKey).fields.status });
  }
}

// Generate indexes
const sprintsIndexContent = generateSprintsIndex(allRecords);
const backlogIndexContent = generateBacklogIndex(allRecords);
const wontFixIndexContent = generateWontFixIndex(allRecords);

const sprintsIndexFile = join(SPRINTS_LOG, "index.md");
const backlogIndexFile = join(BACKLOG_ROOT, "index.md");
const wontFixIndexFile = join(WONTFIX_ROOT, "index.md");

const si = writeIfChanged(sprintsIndexFile, sprintsIndexContent);
const bi = writeIfChanged(backlogIndexFile, backlogIndexContent);
const wi = writeIfChanged(wontFixIndexFile, wontFixIndexContent);

// Report
const verb = CHECK ? "would update" : "updated";
console.log(`\nupdate-issues — ${byId.size} issues indexed`);
console.log(`  ${verb} ${issueFilesUpdated} issue files`);
console.log(`  ${verb} plan/log/sprints/index.md: ${si}`);
console.log(`  ${verb} plan/issues/backlog/index.md: ${bi}`);
console.log(`  ${verb} plan/issues/wont-fix/index.md: ${wi}`);

if (duplicates.length) {
  console.log(`\nDUPLICATE IDs (${duplicates.length}):`);
  for (const [id, entries] of duplicates)
    console.log(`  #${id}:\n${entries.map((e) => `    ${relPath(e.file)}`).join("\n")}`);
}
if (idMismatches.length) {
  console.log(`\nFILENAME/FRONTMATTER ID MISMATCH (${idMismatches.length}):`);
  for (const { file, filename, frontmatter } of idMismatches)
    console.log(`  ${file}: filename prefix=${filename}, frontmatter id=${frontmatter}`);
}
if (dangling.length) {
  console.log(`\nDANGLING depends_on (${dangling.length}):`);
  for (const { from, dep } of dangling) console.log(`  ${from} → #${dep} (not found)`);
}
if (resolved.length) {
  console.log(`\nRESOLVED dependencies (${resolved.length}) — can unblock:`);
  for (const { from, dep, depStatus } of resolved) console.log(`  ${from} → #${dep} (${depStatus})`);
}
