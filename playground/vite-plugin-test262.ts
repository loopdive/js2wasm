import type { Plugin } from "vite";
import { readdirSync, readFileSync, existsSync, statSync, realpathSync } from "fs";
import { join, relative, resolve, normalize } from "path";

const projectRoot = resolve(__dirname, "..");
const publicRoot = join(projectRoot, "public");
const TEST_CATEGORIES = [
  "built-ins/Math/abs",
  "built-ins/Math/ceil",
  "built-ins/Math/floor",
  "built-ins/Math/round",
  "built-ins/Math/trunc",
  "built-ins/Math/sign",
  "built-ins/Math/sqrt",
  "built-ins/Math/min",
  "built-ins/Math/max",
  "built-ins/Math/clz32",
  "built-ins/Math/imul",
  "built-ins/Math/pow",
  "built-ins/Math/exp",
  "built-ins/Math/log",
  "built-ins/Math/sin",
  "built-ins/Math/cos",
  "built-ins/Math/tan",
  "built-ins/Math/asin",
  "built-ins/Math/acos",
  "built-ins/Math/atan",
  "built-ins/Math/atan2",
  "built-ins/Math/acosh",
  "built-ins/Math/asinh",
  "built-ins/Math/atanh",
  "built-ins/Math/cbrt",
  "built-ins/Math/expm1",
  "built-ins/Math/log1p",
  "built-ins/Math/log2",
  "built-ins/Math/log10",
  "built-ins/Math/fround",
  "built-ins/Math/hypot",
  "language/expressions/addition",
  "language/expressions/subtraction",
  "language/expressions/multiplication",
  "language/expressions/division",
  "language/expressions/modulus",
  "language/expressions/exponentiation",
  "language/expressions/concatenation",
  "language/expressions/bitwise-and",
  "language/expressions/bitwise-or",
  "language/expressions/bitwise-xor",
  "language/expressions/bitwise-not",
  "language/expressions/left-shift",
  "language/expressions/right-shift",
  "language/expressions/equals",
  "language/expressions/does-not-equals",
  "language/expressions/strict-equals",
  "language/expressions/strict-does-not-equals",
  "language/expressions/greater-than",
  "language/expressions/greater-than-or-equal",
  "language/expressions/less-than",
  "language/expressions/less-than-or-equal",
  "language/expressions/logical-and",
  "language/expressions/logical-not",
  "language/expressions/logical-or",
  "language/expressions/conditional",
  "language/expressions/comma",
  "language/expressions/typeof",
  "language/expressions/instanceof",
  "language/expressions/void",
  "language/expressions/unary-plus",
  "language/expressions/unary-minus",
  "language/expressions/prefix-increment",
  "language/expressions/prefix-decrement",
  "language/expressions/postfix-increment",
  "language/expressions/postfix-decrement",
  "language/expressions/compound-assignment",
  "language/expressions/logical-assignment",
  "language/expressions/assignment",
  "language/expressions/grouping",
  "language/expressions/call",
  "language/expressions/function",
  "language/expressions/property-accessors",
  "language/expressions/unsigned-right-shift",
  "language/expressions/new",
  "language/expressions/arrow-function",
  "language/expressions/class",
  "language/expressions/object",
  "language/expressions/array",
  "language/expressions/template-literal",
  "language/expressions/tagged-template",
  "language/expressions/generators",
  "language/expressions/async-arrow-function",
  "language/expressions/async-function",
  "language/expressions/await",
  "language/expressions/assignmenttargettype",
  "language/expressions/delete",
  "language/expressions/yield",
  "language/expressions/coalesce",
  "language/expressions/in",
  "language/expressions/this",
  "language/expressions/member-expression",
  "language/expressions/new.target",
  "language/expressions/relational",
  "language/statements/if",
  "language/statements/while",
  "language/statements/do-while",
  "language/statements/for",
  "language/statements/switch",
  "language/statements/break",
  "language/statements/continue",
  "language/statements/return",
  "language/statements/block",
  "language/statements/empty",
  "language/statements/expression",
  "language/statements/variable",
  "language/statements/labeled",
  "language/statements/throw",
  "language/statements/try",
  "language/statements/function",
  "language/statements/for-of",
  "language/statements/for-in",
  "language/statements/class",
  "language/statements/generators",
  "language/statements/async-function",
  "built-ins/Array/isArray",
  "built-ins/Array/prototype/push",
  "built-ins/Array/prototype/pop",
  "built-ins/Array/prototype/indexOf",
  "built-ins/Array/prototype/lastIndexOf",
  "built-ins/Array/prototype/includes",
  "built-ins/Array/prototype/slice",
  "built-ins/Array/prototype/concat",
  "built-ins/Array/prototype/join",
  "built-ins/Array/prototype/reverse",
  "built-ins/Array/prototype/fill",
  "built-ins/Array/prototype/find",
  "built-ins/Array/prototype/findIndex",
  "built-ins/Array/prototype/sort",
  "built-ins/Array/prototype/splice",
  "built-ins/Array/prototype/map",
  "built-ins/Array/prototype/filter",
  "built-ins/Array/prototype/forEach",
  "built-ins/Array/prototype/every",
  "built-ins/Array/prototype/some",
  "built-ins/Array/prototype/reduce",
  "built-ins/Number/isNaN",
  "built-ins/Number/isFinite",
  "built-ins/Number/isInteger",
  "built-ins/Number/parseFloat",
  "built-ins/Number/parseInt",
  "built-ins/Number/POSITIVE_INFINITY",
  "built-ins/Number/NEGATIVE_INFINITY",
  "built-ins/Number/MAX_VALUE",
  "built-ins/Number/MIN_VALUE",
  "built-ins/Number/EPSILON",
  "built-ins/Number/MAX_SAFE_INTEGER",
  "built-ins/Number/MIN_SAFE_INTEGER",
  "built-ins/Number/isSafeInteger",
  "built-ins/Boolean",
  "built-ins/parseInt",
  "built-ins/parseFloat",
  "built-ins/isNaN",
  "built-ins/isFinite",
  "language/types/number",
  "language/types/boolean",
  "language/types/null",
  "language/types/undefined",
  "language/types/string",
  "language/types/reference",
  "built-ins/Object/keys",
  "built-ins/Object/values",
  "built-ins/Object/entries",
  "built-ins/JSON/parse",
  "built-ins/JSON/stringify",
  "built-ins/String/prototype/charAt",
  "built-ins/String/prototype/charCodeAt",
  "built-ins/String/prototype/indexOf",
  "built-ins/String/prototype/lastIndexOf",
  "built-ins/String/prototype/includes",
  "built-ins/String/prototype/startsWith",
  "built-ins/String/prototype/endsWith",
  "built-ins/String/prototype/slice",
  "built-ins/String/prototype/substring",
  "built-ins/String/prototype/trim",
  "built-ins/String/prototype/trimStart",
  "built-ins/String/prototype/trimEnd",
  "built-ins/String/prototype/toLowerCase",
  "built-ins/String/prototype/toUpperCase",
  "built-ins/String/prototype/split",
  "built-ins/String/prototype/replace",
  "built-ins/String/prototype/repeat",
  "built-ins/String/prototype/padStart",
  "built-ins/String/prototype/padEnd",
  "built-ins/String/prototype/concat",
  "built-ins/String/prototype/at",
  "built-ins/Promise/resolve",
  "built-ins/Promise/reject",
  "built-ins/Promise/all",
  "built-ins/Promise/race",
];

interface CategoryInfo {
  name: string;
  path: string;
  fileCount: number;
  files: string[];
}

function collectFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  function walk(d: string) {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".js")) files.push(full);
    }
  }
  walk(dir);
  return files.sort();
}

export function test262Plugin(): Plugin {
  const projectRoot = resolve(__dirname, "..");
  const testBase = join(projectRoot, "test262", "test");

  // Cache the index so we don't rescan on every request
  let cachedIndex: { categories: CategoryInfo[] } | null = null;
  // Cache file lists per category
  const fileListCache = new Map<string, string[]>();

  // Cache JSONL results by category
  let cachedJsonlByCategory: Map<string, { file: string; status: string; error?: string }[]> | null = null;
  let cachedJsonlMtime: number = 0;

  function getJsonlByCategory(): Map<string, { file: string; status: string; error?: string }[]> {
    const jsonlPath = join(projectRoot, "benchmarks", "results", "test262-results.jsonl");
    if (!existsSync(jsonlPath)) return new Map();
    const stat = statSync(jsonlPath);
    if (cachedJsonlByCategory && stat.mtimeMs === cachedJsonlMtime) return cachedJsonlByCategory;

    const map = new Map<string, { file: string; status: string; error?: string }[]>();
    const content = readFileSync(jsonlPath, "utf-8");
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (!entry.category) continue;
        const item: { file: string; status: string; error?: string } = {
          file: entry.file,
          status: entry.status,
        };
        if (entry.error) item.error = entry.error;
        const list = map.get(entry.category);
        if (list) list.push(item);
        else map.set(entry.category, [item]);
      } catch {
        /* skip malformed lines */
      }
    }
    cachedJsonlByCategory = map;
    cachedJsonlMtime = stat.mtimeMs;
    return map;
  }

  function buildIndexFromJsonl(): { categories: CategoryInfo[] } {
    const byCategory = getJsonlByCategory();
    const categories: CategoryInfo[] = [...byCategory.entries()]
      .map(([category, entries]) => {
        const files = [...new Set(entries.map((entry) => entry.file))].sort();
        fileListCache.set(category, files);
        return {
          name: category,
          path: category,
          fileCount: files.length,
          files,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    return { categories };
  }

  // Cache equivalence test snippets
  let cachedEquivTests: { name: string; source: string }[] | null = null;

  function getEquivTests(): { name: string; source: string }[] {
    if (cachedEquivTests && cachedEquivTests.length > 0) return cachedEquivTests;
    const tests: { name: string; source: string }[] = [];
    const testFiles = [
      join(projectRoot, "tests", "ts-wasm-equivalence.test.ts"),
      ...collectFiles(join(projectRoot, "tests", "equivalence")).filter((file) => file.endsWith(".test.ts")),
    ].filter((file, index, all) => existsSync(file) && all.indexOf(file) === index);

    const itRegex = /it\((["'])(.*?)\1[\s\S]*?(?:compileToWasm|assertEquivalent)\(\s*`([\s\S]*?)`/g;
    for (const testFile of testFiles) {
      const content = readFileSync(testFile, "utf-8");
      let match;
      while ((match = itRegex.exec(content)) !== null) {
        const name = match[2];
        let source = match[3];
        const lines = source.split("\n");
        const nonEmpty = lines.filter((l) => l.trim().length > 0);
        if (nonEmpty.length > 0) {
          const minIndent = Math.min(...nonEmpty.map((l) => l.match(/^(\s*)/)?.[1].length ?? 0));
          source = lines
            .map((l) => l.slice(minIndent))
            .join("\n")
            .trim();
        }
        tests.push({ name, source });
      }
    }

    if (tests.length > 0) cachedEquivTests = tests;
    return tests;
  }

  function getIndex() {
    if (cachedIndex) return cachedIndex;
    if (!existsSync(testBase)) {
      cachedIndex = buildIndexFromJsonl();
      return cachedIndex;
    }
    const categories: CategoryInfo[] = [];
    for (const cat of TEST_CATEGORIES) {
      const dir = join(testBase, cat);
      const files = collectFiles(dir);
      if (files.length > 0) {
        const relFiles = files.map((f) => relative(testBase, f));
        categories.push({
          name: cat,
          path: cat,
          fileCount: files.length,
          files: relFiles,
        });
        fileListCache.set(cat, relFiles);
      }
    }
    if (categories.length === 0) {
      cachedIndex = buildIndexFromJsonl();
      return cachedIndex;
    }
    cachedIndex = { categories };
    return cachedIndex;
  }

  return {
    name: "test262-browser",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url!, `http://${req.headers.host}`);

        // Serve static files from project root (benchmarks/, test262/)
        // MUST return 404 for missing files to prevent vite SPA fallback returning HTML
        if (url.pathname.startsWith("/benchmarks/") || url.pathname.startsWith("/test262/")) {
          const publicPath = normalize(join(publicRoot, url.pathname));
          const filePath = normalize(existsSync(publicPath) ? publicPath : join(projectRoot, url.pathname));
          if (!filePath.startsWith(projectRoot)) {
            res.statusCode = 403;
            res.end("Forbidden");
            return;
          }
          if (existsSync(filePath) && statSync(filePath).isFile()) {
            const ext = filePath.split(".").pop() ?? "";
            const mimeTypes: Record<string, string> = {
              html: "text/html",
              json: "application/json",
              jsonl: "application/x-ndjson",
              js: "text/javascript",
              css: "text/css",
              wasm: "application/wasm",
              map: "application/json",
              ts: "text/plain",
              md: "text/plain",
            };
            res.setHeader("Content-Type", mimeTypes[ext] ?? "application/octet-stream");
            res.end(readFileSync(filePath));
            return;
          }
          // File not found — return 404, don't fall through to SPA
          res.statusCode = 404;
          res.end("Not found");
          return;
        }

        if (url.pathname === "/api/test262-index") {
          const index = getIndex();
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(index));
          return;
        }

        // Lightweight summary: categories with counts only, no file lists (~2KB vs ~500KB)
        if (url.pathname === "/api/test262-index-summary") {
          const index = getIndex();
          const summary = index.categories.map((c) => ({
            name: c.name,
            path: c.path,
            fileCount: c.fileCount,
          }));
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ categories: summary }));
          return;
        }

        if (url.pathname === "/api/test262-files") {
          const cat = url.searchParams.get("category");
          if (!cat) {
            res.statusCode = 400;
            res.end("Missing category parameter");
            return;
          }
          // Ensure index is built
          getIndex();
          const files = fileListCache.get(cat) ?? [];
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(files));
          return;
        }

        if (url.pathname === "/api/test262-file") {
          const filePath = url.searchParams.get("path");
          if (!filePath) {
            res.statusCode = 400;
            res.end("Missing path parameter");
            return;
          }
          // Path traversal protection
          const resolved = normalize(join(testBase, filePath));
          if (!resolved.startsWith(testBase)) {
            res.statusCode = 403;
            res.end("Forbidden");
            return;
          }
          if (!existsSync(resolved)) {
            res.statusCode = 404;
            res.end("File not found");
            return;
          }
          // Resolve symlinks and re-check to prevent symlink-based traversal
          const real = realpathSync(resolved);
          const realBase = realpathSync(testBase);
          if (!real.startsWith(realBase)) {
            res.statusCode = 403;
            res.end("Forbidden");
            return;
          }
          try {
            const content = readFileSync(resolved, "utf-8");
            res.setHeader("Content-Type", "text/plain");
            res.end(content);
          } catch {
            res.statusCode = 500;
            res.end("Error reading file");
          }
          return;
        }

        if (url.pathname === "/api/equiv-index") {
          const tests = getEquivTests();
          const index = tests.map((t, i) => ({ name: t.name, index: i }));
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(index));
          return;
        }

        if (url.pathname === "/api/equiv-source") {
          const idx = parseInt(url.searchParams.get("index") ?? "", 10);
          const tests = getEquivTests();
          if (isNaN(idx) || idx < 0 || idx >= tests.length) {
            res.statusCode = 404;
            res.end("Test not found");
            return;
          }
          res.setHeader("Content-Type", "text/plain");
          res.end(tests[idx].source);
          return;
        }

        // ── Test262 results endpoints ──

        if (url.pathname === "/api/test262-results") {
          const reportPath = join(projectRoot, "benchmarks", "results", "test262-report.json");
          if (!existsSync(reportPath)) {
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: "no-report" }));
            return;
          }
          try {
            const content = readFileSync(reportPath, "utf-8");
            res.setHeader("Content-Type", "application/json");
            res.end(content);
          } catch {
            res.statusCode = 500;
            res.end("Error reading report");
          }
          return;
        }

        if (url.pathname === "/api/test262-file-results") {
          const category = url.searchParams.get("category");
          if (!category) {
            res.statusCode = 400;
            res.end("Missing category parameter");
            return;
          }
          try {
            const byCategory = getJsonlByCategory();
            const results = byCategory.get(category) ?? [];
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify(results));
          } catch {
            res.statusCode = 500;
            res.end("Error reading results");
          }
          return;
        }

        next();
      });
    },
  };
}
