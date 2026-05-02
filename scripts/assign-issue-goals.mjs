#!/usr/bin/env node
import fs from "fs";
import path from "path";

const ROOT = process.cwd();
const ISSUES_DIR = path.join(ROOT, "plan", "issues");
const GOALS_DIR = path.join(ROOT, "plan", "goals");

const NON_ISSUE_FILES = new Set([path.join(ISSUES_DIR, "SCHEMA.md"), path.join(ISSUES_DIR, "AUDIT-2026-04-14.md")]);

const GOAL_ALIASES = new Map([
  ["builtins", "builtin-methods"],
  ["builtin-methods, class-system", "class-system"],
  ["compiler-correctness", "compilable"],
  ["compiler-performance", "performance"],
  ["platform-support", "platform"],
  ["runtime-simplicity", "compiler-architecture"],
  ["dashboard", "developer-experience"],
  ["playground-mobile-ux", "developer-experience"],
  ["visibility", "developer-experience"],
  ["process", "contributor-readiness"],
  ["planning", "contributor-readiness"],
  ["conformance-history", "observability"],
  ["test-infra", "test-infrastructure"],
  ["test262-infrastructure", "test-infrastructure"],
  ["test262-correctness", "correctness"],
  ["test262-coverage", "spec-completeness"],
]);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && entry.name.endsWith(".md")) out.push(full);
  }
  return out;
}

function isIssueFile(file) {
  if (NON_ISSUE_FILES.has(file)) return false;
  return path.basename(file) !== "sprint.md";
}

function parseFrontmatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return { data: {}, raw: null };
  const data = {};
  let currentKey = null;
  for (const line of match[1].split("\n")) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (kv) {
      currentKey = kv[1];
      const raw = kv[2].trim();
      if (!raw) data[currentKey] = [];
      else if (raw.startsWith("[")) {
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
  return { data, raw: match[1] };
}

function stripFrontmatter(text) {
  return text.replace(/^---\n[\s\S]*?\n---\n?/, "");
}

function updateGoalFrontmatter(text, goal) {
  const match = text.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return text;
  const lines = match[1].split("\n");
  const goalLine = `goal: ${goal}`;
  const idx = lines.findIndex((line) => /^goal:\s*/.test(line));
  if (idx >= 0) {
    lines[idx] = goalLine;
  } else {
    const anchors = ["reasoning_effort", "feasibility", "priority", "depends_on", "blocked_by"];
    let insertAt = lines.length;
    for (const anchor of anchors) {
      const anchorIdx = lines.findIndex((line) => line.startsWith(`${anchor}:`));
      if (anchorIdx >= 0) {
        insertAt = anchorIdx + 1;
        break;
      }
    }
    lines.splice(insertAt, 0, goalLine);
  }
  return text.replace(/^---\n[\s\S]*?\n---/, `---\n${lines.join("\n")}\n---`);
}

function issueIdFromPath(file) {
  return path.basename(file, ".md");
}

function sprintFromPath(file) {
  const m = file.match(/\/sprints\/(\d+)\//);
  if (m) return m[1];
  if (/\/backlog\//.test(file)) return "backlog";
  return "";
}

function canonicalGoal(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  return GOAL_ALIASES.get(trimmed) || trimmed;
}

function loadGoalNames() {
  return new Set(
    fs
      .readdirSync(GOALS_DIR)
      .filter((name) => name.endsWith(".md") && name !== "goal-graph.md")
      .map((name) => name.replace(/\.md$/, "")),
  );
}

function loadExplicitGoalIssueMap() {
  const map = new Map();
  for (const file of fs.readdirSync(GOALS_DIR).filter((name) => name.endsWith(".md") && name !== "goal-graph.md")) {
    const goal = file.replace(/\.md$/, "");
    const text = fs.readFileSync(path.join(GOALS_DIR, file), "utf8");
    const ids = [...text.matchAll(/\|\s*\*?\*?(\d+[a-z]?)\*?\*?\s*\|/gi)].map((m) => m[1]);
    const unique = [...new Set(ids)];
    for (const id of unique) {
      if (!map.has(id)) map.set(id, new Set());
      map.get(id).add(goal);
    }
  }
  return map;
}

function scoreGoal(text, file, frontmatter, explicitGoals = new Set()) {
  const lower = stripFrontmatter(text).toLowerCase();
  const title = String(frontmatter.title || "").toLowerCase();
  const taskType = String(frontmatter.task_type || "").toLowerCase();
  const languageFeature = String(frontmatter.language_feature || "").toLowerCase();
  const esEdition = String(frontmatter.es_edition || "").toLowerCase();
  const status = String(frontmatter.status || "").toLowerCase();
  const sprint = sprintFromPath(file).toLowerCase();
  const currentGoal = canonicalGoal(frontmatter.goal);
  const combined = `${title}\n${taskType}\n${languageFeature}\n${esEdition}\n${status}\n${sprint}\n${lower}`;
  const filepath = file.toLowerCase();
  const scores = new Map();
  const add = (goal, points) => scores.set(goal, (scores.get(goal) || 0) + points);
  const has = (re) => re.test(combined);

  if (title.includes("separate es-module compilation")) return { goal: "compiler-architecture", score: 100 };
  if (title.includes("upgrade to typescript 6.x")) return { goal: "spec-completeness", score: 100 };

  for (const goal of explicitGoals) add(goal, 5);
  if (currentGoal && GOAL_NAMES.has(currentGoal)) add(currentGoal, 2);

  if (has(/\bnull[_ -]?deref|\billegal cast\b|\btrap\b|\bruntimeerror\b|\bthrowonnull\b/)) add("crash-free", 8);
  if (
    has(
      /\bsyntaxerror\b|\breferenceerror\b|\brangeerror\b|\btypeerror\b|\bassert\.throws\b|\btdz\b|\bnegative test\b|\bearly error\b/,
    )
  )
    add("error-model", 8);
  if (
    has(
      /\bcompile error\b|\bcompiler timeout\b|\bunsupported\b|\bwasm validation\b|\btype mismatch\b|\bcall_ref\b|\bstruct\.new\b|\bcoercion\b/,
    ) &&
    !has(/\bwrong return value\b/)
  )
    add("compilable", 7);
  if (
    has(
      /\bwrong return value\b|\bwrong value\b|\bcore semantics\b|\barguments object\b|\bcoercion\b|\bannexb\b|\bbindingelement\b/,
    )
  )
    add("core-semantics", 7);
  if (
    has(
      /\bdo-while\b|\bswitch statements?\b|\bfor-loop\b|\bternary\b|\bconditional expression\b|\bbitwise\b|\bexponentiation\b|\bdestructuring\b|\boptional chaining\b|\bnullish coalescing\b/,
    )
  )
    add("core-semantics", 8);
  if (
    has(
      /\bprivate fields?\b|\bprivate methods?\b|\bprivate accessors?\b|\bclass declaration\b|\bclass expression\b|\bstatic block\b|\binstanceof\b|\bgetter\b|\bsetter\b/,
    )
  )
    add("class-system", 7);
  if (
    has(
      /\bobject\.defineproperty\b|\bhasownproperty\b|\bproperty descriptor\b|\bpropertyhelper\b|\bpreventextensions\b|\bprototype chain\b|\b__proto__\b|\bobject\.create\b/,
    )
  )
    add("property-model", 8);
  if (has(/\biterator\b|\biterable\b|\bfor-of\b|\bfor await\b|\bsymbol\.iterator\b/)) add("iterator-protocol", 8);
  if (has(/\bgenerator\b|\byield\*?\b|\.next\(/)) add("generator-model", 7);
  if (has(/\basync\b|\bawait\b|\bpromise\b|\bthrowsasync\b/)) add("async-model", 7);
  if (has(/\basync\/await\b|\bpromises?\b/)) add("async-model", 9);
  if (
    has(
      /\bsymbol\.toprimitive\b|\bsymbol\.species\b|\bsymbol\.tostringtag\b|\bsymbol\.hasinstance\b|\bwell-known symbol\b|\buser symbol\b/,
    )
  )
    add("symbol-protocol", 8);
  if (has(/\bregexp\b|\barray method\b|\bstring method\b|\bmath\b|\bdate\b|\bnumber\b|\.bind\(/))
    add("builtin-methods", 6);
  if (
    has(
      /\btemporal\b|\bsharedarraybuffer\b|\batomics\b|\bproxy\b|\beval\b|\bweakref\b|\bfinalizationregistry\b|\bwith statement\b|\bawait using\b|\bunicode 16\.0\.0\b|\bunicode identifiers?\b/,
    )
  )
    add("spec-completeness", 8);
  if (
    has(
      /\bwasi\b|\bwasi http\b|\bcomponent model\b|\bshopify\b|\bcloudflare\b|\bdeno\b|\bfastly\b|\bfermyon\b|\bedge deployment\b|\bdeploy to edge\b|\bhost imports?\b/,
    )
  )
    add("platform", 9);
  if (
    has(
      /\bstandalone\b|\bwithout js host\b|\bwithout a js host\b|\bwithout embedding a js engine\b|\bwithout shipping a js runtime\b|\bwasm-native\b|\bnative string\b|\bnative regex\b|\blinear memory\b|\bcompile-time arc\b|\bdataview bridge\b/,
    )
  )
    add("standalone-mode", 8);
  if (
    has(
      /\bmonomorph\b|\btype flow\b|\bcompilerhost\b|\bescape analysis\b|\bbenchmark\b|\bperformance\b|\btimeout\b|\bspeedup\b|\boptimi[sz]/,
    )
  )
    add("performance", 7);
  if (
    has(
      /\bimport manifest\b|\bclosed world\b|\blink-time\b|\bseparate compilation\b|\bconsumer-driven\b|\bspecialization\b|\bmodule interface descriptor\b|\bwidl\b|\bwhole-program\b|\bhost contract\b|\barchitecture\b/,
    )
  )
    add("compiler-architecture", 9);
  if (
    has(
      /\bgithub actions\b|\bworkflow\b|\bbaseline\b|\bregression gate\b|\bci-status-feed\b|\bmerge job\b|\bpages build\b|\bcommit hash\b/,
    )
  )
    add("ci-hardening", 9);
  if (
    has(
      /\bplayground\b|\blanding page\b|\bdashboard\b|\bmobile\b|\bui\b|\bsite nav\b|\bfooter\b|\blogo\b|\breport page\b|\bpanel\b|\bweb component\b|\bvite dev server\b|\bsource-mapped location\b/,
    )
  )
    add("developer-experience", 7);
  if (has(/\brefactor\b|\bsplit\b|\bextract\b|\bmodular\b|\bsmaller modules\b|\bdedup\b|\bmemoize\b|\bcleanup\b/))
    add("maintainability", 8);
  if (has(/\bnpm\b|\bcommonjs\b|\bcjs\b|\besm\b|\bexport default\b|\baxios\b|\breact\b|\blibrary\b/))
    add("npm-library-support", 8);
  if (
    has(
      /\bhistory\b|\bcheckpoint\b|\bsupport matrix\b|\bcompare all js-to-wasm engines\b|\bcompare .* engines\b|\bobservability\b/,
    )
  )
    add("observability", 8);
  if (
    has(
      /\btest262 runner\b|\bfixture tests\b|\bcompiler pool\b|\brunner state leak\b|\bbaseline-diff\b|\bsloppy\b|\bstatusline\b|\blive-streaming report\b|\bunified mode\b/,
    )
  )
    add("test-infrastructure", 8);
  if (
    has(
      /\bmetadata\b|\bfrontmatter\b|\bplanning-data\b|\bcontributor\b|\bcontributing\.md\b|\brepo hygiene\b|\bstarter issue\b/,
    )
  )
    add("contributor-readiness", 8);
  if (has(/\bspec conformance audit\b|\bcorrectness audit\b/)) add("correctness", 8);

  if (filepath.includes(`${path.sep}backlog${path.sep}`) && has(/\bplanning\b|\bprocess\b/))
    add("contributor-readiness", 6);
  if (filepath.includes(`${path.sep}backlog${path.sep}`) && has(/\bdependency graph\b/)) add("developer-experience", 6);
  if (has(/\boffline-first benchmarks\b|\bplaywright dom measurement\b|\brun live button\b/)) add("observability", 10);
  if (has(/\bcompile axios\b|\bcompile react\b/)) add("npm-library-support", 10);
  if (has(/\bseparate es-module compilation\b|\bimport\/export type specialization\b/))
    add("compiler-architecture", 10);
  if (has(/\bshared compiler pool\b|\bworker pool\b|\bcompiler-worker\b/)) add("test-infrastructure", 12);
  if (has(/\bes version filtering\b|\bbaseline compatibility mode\b|\bfeature-to-es-version mapping\b/))
    add("test-infrastructure", 11);
  if (
    has(
      /\bmonaco\b|\bweb workers?\b|\bburger-menu\b|\bcircular progress\b|\bper-feature error list\b|\blayout support\b/,
    )
  )
    add("developer-experience", 12);
  if (has(/\bwasm-native error\b|\berror construction\b|\bstack traces without js host\b/)) add("standalone-mode", 12);
  if (has(/\bproxy\b/)) add("spec-completeness", 4);
  if (has(/\beval\b|\bfunction\(\)/)) add("spec-completeness", 4);
  if (has(/\bstring method implementations\b/)) add("standalone-mode", 4);
  if (has(/\bcomponent model\b|\bwasi http\b|\bshopify\b|\bcloudflare\b|\bdeno\b/)) add("platform", 10);
  if (has(/\bcompiler pool\b|\bvitest\b|\btest262\b|\brunner\b/)) add("test-infrastructure", 5);
  if (has(/\bstatusline\b|\bbaseline compatibility mode\b|\bes version filtering\b/)) add("observability", 6);
  if (has(/\bdom support\b/)) add("platform", 5);
  if (taskType === "ui" || taskType === "ux") add("developer-experience", 9);
  if (taskType === "docs" || taskType === "documentation" || taskType === "planning") add("contributor-readiness", 9);
  if (taskType === "refactor") add("maintainability", 9);
  if (
    languageFeature.includes("playground") ||
    languageFeature.includes("dashboard") ||
    languageFeature.includes("landing") ||
    languageFeature.includes("mobile") ||
    languageFeature.includes("ui")
  )
    add("developer-experience", 10);
  if (languageFeature.includes("test262") || languageFeature.includes("runner") || languageFeature.includes("baseline"))
    add("test-infrastructure", 10);
  if (
    languageFeature.includes("module") ||
    languageFeature.includes("link-time") ||
    languageFeature.includes("specialization") ||
    languageFeature.includes("architecture")
  )
    add("compiler-architecture", 10);
  if (
    languageFeature.includes("standalone") ||
    languageFeature.includes("host-import") ||
    languageFeature.includes("wasi") ||
    languageFeature.includes("component-model")
  )
    add("standalone-mode", 10);
  if (languageFeature.includes("npm") || languageFeature.includes("commonjs") || languageFeature.includes("esm"))
    add("npm-library-support", 10);
  if (
    languageFeature.includes("unicode") ||
    languageFeature.includes("proposal") ||
    languageFeature.includes("temporal")
  )
    add("spec-completeness", 10);
  if (esEdition && esEdition !== "n/a") add("spec-completeness", 2);
  if (
    has(
      /\bmobile-first layout support to the playground\b|\bplayground: monaco web workers fail to load\b|\blanding page es edition ui\b/,
    )
  )
    add("developer-experience", 50);
  if (
    has(
      /\bshared compiler pool for vitest test262 runner\b|\bes version filtering and baseline compatibility mode for test262\b/,
    )
  )
    add("test-infrastructure", 50);
  if (has(/\bseparate es-module compilation with consumer-driven import\/export type specialization\b/))
    add("compiler-architecture", 50);
  if (has(/\bwasm-native error construction and stack traces without js host\b/)) add("standalone-mode", 50);
  if (has(/\bupgrade to typescript 6\.x\b|\bunicode 16\.0\.0 identifiers?\b/)) add("spec-completeness", 40);

  let bestGoal = "";
  let bestScore = -1;
  for (const [goal, score] of scores) {
    if (score > bestScore) {
      bestGoal = goal;
      bestScore = score;
    }
  }
  return { goal: bestGoal, score: bestScore };
}

const GOAL_NAMES = loadGoalNames();
const explicitGoalMap = loadExplicitGoalIssueMap();
const files = walk(ISSUES_DIR).filter(isIssueFile);

let updated = 0;
let assignedFromExplicit = 0;
let assignedFromExisting = 0;
let assignedFromHeuristic = 0;
let unresolved = 0;
const unresolvedIssues = [];

for (const file of files) {
  const text = fs.readFileSync(file, "utf8");
  const { data } = parseFrontmatter(text);
  if (!data.title && !data.status && !data.id) continue;
  const id = String(data.id || issueIdFromPath(file));

  let goal = "";
  let source = "";

  const explicit = explicitGoalMap.get(id) || new Set();
  const inferred = scoreGoal(text, file, data, explicit);
  if (inferred.goal && GOAL_NAMES.has(inferred.goal)) {
    goal = inferred.goal;
    source = explicit.has(goal) ? "explicit" : "heuristic";
  }

  if (!goal) {
    const current = canonicalGoal(data.goal);
    if (current && GOAL_NAMES.has(current)) {
      goal = current;
      source = "existing";
    }
  }

  if (!goal) {
    unresolved += 1;
    unresolvedIssues.push({ id, title: data.title || "", status: data.status || "", file: path.relative(ROOT, file) });
    continue;
  }

  const next = updateGoalFrontmatter(text, goal);
  if (next !== text) {
    fs.writeFileSync(file, next);
    updated += 1;
  }
  if (source === "explicit") assignedFromExplicit += 1;
  else if (source === "existing") assignedFromExisting += 1;
  else if (source === "heuristic") assignedFromHeuristic += 1;
}

console.log(
  JSON.stringify(
    {
      updated,
      assignedFromExplicit,
      assignedFromExisting,
      assignedFromHeuristic,
      unresolved,
      unresolvedIssues: unresolvedIssues.slice(0, 100),
    },
    null,
    2,
  ),
);
