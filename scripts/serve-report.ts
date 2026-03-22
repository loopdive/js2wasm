#!/usr/bin/env npx tsx
/**
 * Serve the test262 conformance report with source file access.
 *
 * Usage: npx tsx scripts/serve-report.ts [port]
 * Default port: 8080
 *
 * Serves:
 *   /                    → benchmarks/report.html
 *   /benchmarks/...      → benchmarks/ directory
 *   /test262/...         → test262/ directory (source files)
 *   /test262-out/...     → test262-out/ directory (compiled wasm + maps)
 */
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";

const PORT = parseInt(process.argv[2] ?? "8080", 10);
const ROOT = join(import.meta.dirname ?? __dirname, "..");

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json",
  ".jsonl": "application/x-ndjson",
  ".css": "text/css",
  ".wasm": "application/wasm",
  ".map": "application/json",
  ".ts": "text/typescript",
  ".md": "text/markdown",
  ".txt": "text/plain",
};

const server = createServer((req, res) => {
  let url = decodeURIComponent(req.url ?? "/");
  if (url === "/") url = "/benchmarks/report.html";

  // Security: prevent path traversal
  if (url.includes("..")) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  const filePath = join(ROOT, url);

  if (!existsSync(filePath)) {
    res.writeHead(404);
    res.end("Not found: " + url);
    return;
  }

  try {
    const data = readFileSync(filePath);
    const ext = extname(filePath);
    res.writeHead(200, {
      "Content-Type": MIME[ext] ?? "application/octet-stream",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(data);
  } catch (err: any) {
    res.writeHead(500);
    res.end("Error: " + err.message);
  }
});

server.listen(PORT, () => {
  console.log(`Report server running at http://localhost:${PORT}`);
  console.log(`  Report:  http://localhost:${PORT}/benchmarks/report.html`);
  console.log(`  Results: http://localhost:${PORT}/benchmarks/results/test262-report.json`);
  console.log(`  Sources: http://localhost:${PORT}/test262/test/...`);
  console.log(`  Wasm:    http://localhost:${PORT}/test262-out/test/...`);
});
