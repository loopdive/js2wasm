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

// When the same issue ID appears in multiple sprint snapshot directories
// (e.g. a done issue in sprints/42/ and a carry-forward in sprints/45/),
// prefer the version with the highest-priority status so that done issues
// don't show up as "ready" in a later sprint's board.
const STATUS_PRIORITY = {
  done: 0,
  "wont-fix": 1,
  blocked: 2,
  review: 3,
  "in-progress": 4,
  ready: 5,
  deferred: 6,
  backlog: 7,
};
function issueStatusPriority(status) {
  return STATUS_PRIORITY[status] ?? 8;
}

function loadIssues() {
  if (!existsSync(ISSUE_ROOT)) return [];
  const trackedFiles = getTrackedMarkdownFiles("plan/issues");
  const raw = walkFiles(ISSUE_ROOT)
    .filter((file) => isIssueFileName(file.split("/").pop()))
    .filter((file) => !trackedFiles || trackedFiles.has(file))
    .map((file) => {
      const text = readFileSync(file, "utf-8");
      const f = file.split("/").pop();
      const fm = parseFrontmatter(text);
      const id = String(fm.id || f.replace(".md", ""));
      const title = fm.title || extractTitle(text);
      // Sprint membership: prefer explicit `sprint:` frontmatter, but fall
      // back to the parent directory name. The repo convention is that an
      // issue file at `plan/issues/sprints/<N>/<id>-…md` belongs to sprint
      // <N>, even when the frontmatter omits the field. (The dashboard
      // previously dropped 55+ sprint-47 issues that didn't have an explicit
      // `sprint:` line — that's the root cause behind "sprint shows only one
      // ticket" reports.)
      const dirSegments = file.split("/");
      const sprintsIdx = dirSegments.lastIndexOf("sprints");
      const sprintFromDir =
        sprintsIdx >= 0 && sprintsIdx + 1 < dirSegments.length - 1 ? dirSegments[sprintsIdx + 1] : "";
      return {
        id,
        title,
        priority: fm.priority || "medium",
        feasibility: fm.feasibility || "",
        depends_on: fm.depends_on || [],
        goal: fm.goal || "",
        status: normalizeIssueStatus(fm.status),
        sprint: fm.sprint || sprintFromDir,
      };
    });

  // Deduplicate by ID — same issue can appear in multiple sprint snapshot dirs.
  // Keep the copy with the highest-priority status (done beats ready/deferred).
  const byId = new Map();
  for (const issue of raw) {
    const existing = byId.get(issue.id);
    if (!existing || issueStatusPriority(issue.status) < issueStatusPriority(existing.status)) {
      byId.set(issue.id, issue);
    }
  }
  return [...byId.values()].sort((a, b) => String(b.id).localeCompare(String(a.id), undefined, { numeric: true })); // newest first
}

const issues = {
  backlog: [],
  blocked: [],
  ready: [],
  inprogress: [],
  review: [],
  done: [],
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
  } else if (iss.status === "done" || iss.status === "wont-fix") {
    // wont-fix is a label, not a separate lane — shown in Done with a tag
    issues.done.push(iss);
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
];
const issueIdsBySprint = new Map();
const completedIssueIdsBySprint = new Map();
for (const issue of allIssueEntries) {
  const sprintNumber = extractSprintNumberFromLabel(issue.sprint);
  if (!Number.isFinite(sprintNumber)) continue;
  if (!issueIdsBySprint.has(sprintNumber)) issueIdsBySprint.set(sprintNumber, new Set());
  issueIdsBySprint.get(sprintNumber).add(String(issue.id));
  if (issue.status === "done" || issue.status === "wont-fix") {
    if (!completedIssueIdsBySprint.has(sprintNumber)) completedIssueIdsBySprint.set(sprintNumber, new Set());
    completedIssueIdsBySprint.get(sprintNumber).add(String(issue.id));
  }
}

writeFileSync(join(OUT, "issues.json"), JSON.stringify(issues, null, 2));
console.log(
  `Issues: ${issues.backlog.length} backlog, ${issues.ready.length} ready, ${issues.inprogress.length} in-progress, ${issues.review.length} in-review, ${issues.blocked.length} blocked, ${issues.done.length} done (incl. wont-fix)`,
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
// Determine isClosed / isPlanning using explicit frontmatter status where available.
// Legacy sprints (status === "") fall back to the maxSprintNumber heuristic, but
// only compared against other legacy sprints so that new "planning" sprints don't
// push the current active sprint into isClosed.
const CLOSED_STATUSES = new Set(["closed", "done"]);
const ACTIVE_STATUSES = new Set(["planned", "active"]);
const PLANNING_STATUSES = new Set(["planning"]);
const explicitlyClosedMax = Math.max(
  ...sprints.filter((s) => CLOSED_STATUSES.has(s.status)).map((s) => s.sprintNumber || 0),
  0,
);
for (const sprint of sprints) {
  sprint.isPlanning = PLANNING_STATUSES.has(sprint.status);
  if (CLOSED_STATUSES.has(sprint.status)) {
    sprint.isClosed = true;
  } else if (ACTIVE_STATUSES.has(sprint.status) || PLANNING_STATUSES.has(sprint.status)) {
    sprint.isClosed = false;
  } else {
    // Legacy sprint with no status field: closed if at or below the explicit threshold.
    sprint.isClosed = sprint.sprintNumber <= explicitlyClosedMax || sprint.explicitCarryOver;
  }
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

// ── Feature test stats (#1327) ───────────────────────────────────
//
// Augments public/feature-examples.json with per-feature test262 stats
// (`testCategories`, `passCount`, `totalCount`, `tests[]`) so the landing
// page can surface live pass/fail counts and link to the new feature
// report page (public/benchmarks/feature-report.html).
//
// Each feature is mapped (by name) to one or more test262 path prefixes.
// Prefixes match against `entry.file` as `test/<prefix>/...` — broad
// prefixes (e.g. `built-ins/Array`) cover all sub-tests. Per the spec
// (#1327) we use 1-5 prefixes per feature; a few features that span
// many sub-areas (e.g. Operators) get a slightly wider list.
//
// First-feature-wins: each test is bucketed into the FIRST feature whose
// testCategories prefix matches its file path. Order in feature-examples.json
// therefore matters — the iteration order is the priority order.
const FEATURE_TEST_CATEGORIES = {
  "Primitive types (string, number, boolean, null, undefined)": ["language/types", "language/literals"],
  "Operators (arithmetic, comparison, logical, bitwise)": [
    "language/expressions/addition",
    "language/expressions/subtraction",
    "language/expressions/multiplication",
    "language/expressions/division",
    "language/expressions/modulus",
    "language/expressions/bitwise-and",
    "language/expressions/bitwise-or",
    "language/expressions/bitwise-xor",
    "language/expressions/bitwise-not",
    "language/expressions/left-shift",
    "language/expressions/right-shift",
    "language/expressions/unsigned-right-shift",
    "language/expressions/equals",
    "language/expressions/does-not-equals",
    "language/expressions/strict-equals",
    "language/expressions/strict-does-not-equals",
    "language/expressions/less-than",
    "language/expressions/less-than-or-equal",
    "language/expressions/greater-than",
    "language/expressions/greater-than-or-equal",
    "language/expressions/logical-and",
    "language/expressions/logical-or",
    "language/expressions/logical-not",
    "language/expressions/unary-plus",
    "language/expressions/unary-minus",
    "language/expressions/conditional",
    "language/expressions/grouping",
    "language/expressions/postfix-increment",
    "language/expressions/postfix-decrement",
    "language/expressions/prefix-increment",
    "language/expressions/prefix-decrement",
    "language/expressions/in",
    "language/expressions/void",
    "language/expressions/concatenation",
    "language/expressions/relational",
  ],
  "typeof / instanceof": ["language/expressions/typeof", "language/expressions/instanceof"],
  "delete operator": ["language/expressions/delete"],
  "Comma operator": ["language/expressions/comma"],
  "Labeled statements (break / continue)": ["language/statements/labeled"],
  "for-in": ["language/statements/for-in"],
  "arguments object (full)": ["language/arguments-object"],
  "eval()": ["language/eval-code", "built-ins/eval"],
  "with statement": ["language/statements/with", "annexB/language/statements/with"],
  "Variables (var, let, const)": [
    "language/statements/let",
    "language/statements/const",
    "language/statements/variable",
    "language/block-scope",
  ],
  "Functions & closures": ["language/statements/function", "language/function-code", "built-ins/Function"],
  "Control flow": [
    "language/statements/if",
    "language/statements/switch",
    "language/statements/while",
    "language/statements/do-while",
    "language/statements/for",
    "language/statements/break",
    "language/statements/continue",
    "language/statements/return",
  ],
  "try / catch / finally": ["language/statements/try"],
  throw: ["language/statements/throw"],
  Objects: ["language/expressions/object", "built-ins/Object"],
  Strings: ["built-ins/String", "built-ins/StringIteratorPrototype"],
  Numbers: ["built-ins/Number", "built-ins/Math"],
  JSON: ["built-ins/JSON"],
  "Error types": ["built-ins/Error", "built-ins/NativeErrors", "built-ins/AggregateError", "built-ins/SuppressedError"],
  Arrays: ["built-ins/Array", "built-ins/ArrayIteratorPrototype", "language/expressions/array"],
  "Regular expressions": ["built-ins/RegExp", "built-ins/RegExpStringIteratorPrototype"],
  "Property accessors (get / set)": ["language/expressions/property-accessors"],
  "Object.defineProperty (full)": ["built-ins/Object/defineProperty"],
  "Arrow functions": ["language/expressions/arrow-function", "language/expressions/async-arrow-function"],
  "Template literals": ["language/expressions/template-literal", "language/expressions/tagged-template"],
  Destructuring: ["language/destructuring"],
  "Spread / rest operators": ["language/rest-parameters"],
  "Default parameters": ["language/statements/function/default-parameter"],
  "Computed property names": ["language/computed-property-names"],
  "for-of": ["language/statements/for-of"],
  "Generators (function*, yield)": [
    "language/statements/generators",
    "language/expressions/generators",
    "language/expressions/yield",
    "built-ins/GeneratorFunction",
    "built-ins/GeneratorPrototype",
  ],
  Classes: [
    "language/expressions/class",
    "language/statements/class",
    "language/expressions/super",
    "language/expressions/new",
    "language/expressions/new.target",
  ],
  "Map / Set": [
    "built-ins/Map",
    "built-ins/Set",
    "built-ins/MapIteratorPrototype",
    "built-ins/SetIteratorPrototype",
    "built-ins/WeakMap",
    "built-ins/WeakSet",
  ],
  Symbol: ["built-ins/Symbol"],
  "TypedArray / ArrayBuffer": [
    "built-ins/TypedArray",
    "built-ins/TypedArrayConstructors",
    "built-ins/ArrayBuffer",
    "built-ins/DataView",
    "built-ins/Uint8Array",
  ],
  "Modules (import / export)": ["language/module-code", "language/import", "language/export"],
  "Proxy / Reflect": ["built-ins/Proxy", "built-ins/Reflect"],
  "Promise .then / .catch / .finally": ["built-ins/Promise"],
  "async / await": [
    "built-ins/AsyncFunction",
    "language/expressions/await",
    "language/expressions/async-function",
    "language/statements/async-function",
  ],
  "Object.entries / values": ["built-ins/Object/entries", "built-ins/Object/values"],
  "SharedArrayBuffer / Atomics": ["built-ins/SharedArrayBuffer", "built-ins/Atomics"],
  "Object spread / rest": ["language/expressions/object/spread"],
  "Async iteration (for-await-of)": [
    "built-ins/AsyncGeneratorFunction",
    "built-ins/AsyncGeneratorPrototype",
    "built-ins/AsyncIteratorPrototype",
    "built-ins/AsyncFromSyncIteratorPrototype",
    "language/expressions/async-generator",
    "language/statements/async-generator",
  ],
  "Optional chaining (?.)": ["language/expressions/optional-chaining"],
  "Nullish coalescing (??)": ["language/expressions/coalesce"],
  globalThis: ["built-ins/global", "built-ins/globalThis"],
  BigInt: ["built-ins/BigInt"],
  "Dynamic import()": ["language/expressions/dynamic-import"],
  "WeakRef / FinalizationRegistry": ["built-ins/WeakRef", "built-ins/FinalizationRegistry"],
  "Class fields (public, private, static)": ["language/statements/class/fields"],
  "Error.cause": ["built-ins/Error/cause"],
  "Array.at / String.at": ["built-ins/Array/prototype/at", "built-ins/String/prototype/at"],
  "Top-level await": ["language/module-code/top-level-await"],
  "Array.prototype.includes": ["built-ins/Array/prototype/includes"],
  "Exponentiation operator (**)": ["language/expressions/exponentiation"],
  "Optional catch binding": ["language/statements/try/optional-catch-binding"],
  "Array.prototype.flat / flatMap": ["built-ins/Array/prototype/flat", "built-ins/Array/prototype/flatMap"],
  "Object.fromEntries": ["built-ins/Object/fromEntries"],
  "Array.findLast / findLastIndex": ["built-ins/Array/prototype/findLast", "built-ins/Array/prototype/findLastIndex"],
  "Change array by copy (toSorted, toReversed, toSpliced)": [
    "built-ins/Array/prototype/toSorted",
    "built-ins/Array/prototype/toReversed",
    "built-ins/Array/prototype/toSpliced",
  ],
  "Hashbang (#!) comments": ["language/comments/hashbang", "language/source-text"],
  "Promise.withResolvers": ["built-ins/Promise/withResolvers"],
  "Resizable ArrayBuffer": ["built-ins/ArrayBuffer/prototype/resize"],
  "RegExp v flag": ["built-ins/RegExp/unicodeSets"],
  "Set methods (union, intersection, difference)": [
    "built-ins/Set/prototype/union",
    "built-ins/Set/prototype/intersection",
    "built-ins/Set/prototype/difference",
    "built-ins/Set/prototype/symmetricDifference",
    "built-ins/Set/prototype/isSubsetOf",
    "built-ins/Set/prototype/isSupersetOf",
    "built-ins/Set/prototype/isDisjointFrom",
  ],
  "Iterator helpers (map, filter, take)": ["built-ins/Iterator"],
  "RegExp duplicate named groups": ["built-ins/RegExp/named-groups"],
  "var hoisting": ["language/statements/variable", "language/statements/var"],
  "arguments.callee": ["language/arguments-object/callee"],
  "__proto__ accessor": ["annexB/language/expressions/object/__proto__"],
  "String.prototype.substr": ["annexB/built-ins/String/prototype/substr"],
  "Octal literals (0777)": ["annexB/language/literals/numeric"],
  "escape() / unescape()": ["annexB/built-ins/escape", "annexB/built-ins/unescape"],
  "Function.prototype.caller": ["annexB/built-ins/Function/prototype/caller"],
  "HTML string methods (.bold(), .anchor())": [
    "annexB/built-ins/String/prototype/anchor",
    "annexB/built-ins/String/prototype/big",
    "annexB/built-ins/String/prototype/blink",
    "annexB/built-ins/String/prototype/bold",
    "annexB/built-ins/String/prototype/fixed",
    "annexB/built-ins/String/prototype/fontcolor",
    "annexB/built-ins/String/prototype/fontsize",
    "annexB/built-ins/String/prototype/italics",
    "annexB/built-ins/String/prototype/link",
    "annexB/built-ins/String/prototype/small",
    "annexB/built-ins/String/prototype/strike",
    "annexB/built-ins/String/prototype/sub",
    "annexB/built-ins/String/prototype/sup",
  ],
  "RegExp.$1 static properties": ["annexB/built-ins/RegExp/legacy-accessors"],
  Temporal: ["built-ins/Temporal"],
  Decorators: [],
  "Pattern matching": [],
};

/**
 * Compute per-feature test262 stats and rewrite public/feature-examples.json.
 * No-op if the file or the JSONL baseline is missing.
 *
 * @param {string} jsonlPath  Path to the test262 JSONL baseline.
 * @param {string} examplesPath  Path to public/feature-examples.json.
 */
function buildFeatureStats(jsonlPath, examplesPath) {
  if (!existsSync(examplesPath)) {
    console.warn(`Feature stats: ${examplesPath} not found, skipping.`);
    return;
  }
  const examples = JSON.parse(readFileSync(examplesPath, "utf-8"));
  if (!Array.isArray(examples?.features)) {
    console.warn(`Feature stats: ${examplesPath} has no features array, skipping.`);
    return;
  }

  // Attach testCategories to every feature first (always — useful for the
  // feature-report page even when the baseline JSONL is unavailable).
  for (const feature of examples.features) {
    feature.testCategories = FEATURE_TEST_CATEGORIES[feature.name] ?? [];
    feature.passCount = 0;
    feature.totalCount = 0;
    feature.tests = [];
  }

  if (!existsSync(jsonlPath)) {
    console.warn(`Feature stats: ${jsonlPath} not found — features tagged with empty stats.`);
    examples.features_generated = new Date().toISOString();
    writeFileSync(examplesPath, JSON.stringify(examples, null, 2));
    return;
  }

  // Build a list of (feature, prefixes) tuples in feature-list order so first
  // match wins, plus a same-order array of accumulators.
  const lookup = examples.features.map((f) => ({
    feature: f,
    prefixes: f.testCategories,
    pass: 0,
    total: 0,
    tests: [],
  }));

  const lines = readFileSync(jsonlPath, "utf-8").split("\n");
  let bucketed = 0;
  for (const line of lines) {
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const file = String(entry.file || "");
    if (!file) continue;
    // Match against `test/<prefix>/` so prefix `built-ins/Array` does NOT
    // match `built-ins/ArrayBuffer`.
    let matched = null;
    for (const slot of lookup) {
      for (const prefix of slot.prefixes) {
        if (file === `test/${prefix}` || file.startsWith(`test/${prefix}/`)) {
          matched = slot;
          break;
        }
      }
      if (matched) break;
    }
    if (!matched) continue;
    bucketed++;
    matched.total++;
    if (entry.status === "pass") matched.pass++;
    matched.tests.push({
      file,
      status: entry.status,
      error: entry.error ?? "",
      error_category: entry.error_category ?? "",
    });
  }

  // Sort failures first, then compile_error, then pass; cap per feature at 500.
  const STATUS_RANK = { fail: 0, compile_error: 1, compile_timeout: 2, skip: 3, pass: 4 };
  const TESTS_PER_FEATURE_CAP = 500;
  for (const slot of lookup) {
    slot.tests.sort((a, b) => {
      const ra = STATUS_RANK[a.status] ?? 9;
      const rb = STATUS_RANK[b.status] ?? 9;
      if (ra !== rb) return ra - rb;
      return a.file.localeCompare(b.file);
    });
    slot.feature.passCount = slot.pass;
    slot.feature.totalCount = slot.total;
    slot.feature.testsTruncated = slot.tests.length > TESTS_PER_FEATURE_CAP;
    slot.feature.tests = slot.tests.slice(0, TESTS_PER_FEATURE_CAP);
  }

  examples.features_generated = new Date().toISOString();
  writeFileSync(examplesPath, JSON.stringify(examples, null, 2));
  console.log(
    `Feature stats: bucketed ${bucketed} of ${lines.length - 1} test262 entries across ${
      examples.features.length
    } features.`,
  );
}

buildFeatureStats(join(ROOT, "benchmarks/results/test262-current.jsonl"), join(ROOT, "public/feature-examples.json"));

console.log("Done. Open dashboard/index.html in a browser.");
