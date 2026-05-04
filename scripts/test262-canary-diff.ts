#!/usr/bin/env -S npx tsx
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1217 — Test262 canary diff. Symmetric (no baseline/candidate concept):
// counts tests that flipped pass↔non-pass between two runs of the same SHA.
//
// Usage:
//   npx tsx scripts/test262-canary-diff.ts <run-a.jsonl> <run-b.jsonl>
//
// The script writes a human-readable summary to stdout, and on the LAST
// line writes `FLIP_COUNT=<N>` so a CI step can grep it cheaply.

import { readFileSync } from "node:fs";

interface Entry {
  file: string;
  status: string;
}

function loadResults(path: string): Map<string, string> {
  const raw = readFileSync(path, "utf-8");
  const out = new Map<string, string>();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const d = JSON.parse(line) as Partial<Entry>;
      if (typeof d.file === "string" && typeof d.status === "string") {
        // Last write wins — JSONL may contain duplicates from re-runs.
        out.set(d.file, d.status);
      }
    } catch {
      // Skip malformed lines.
    }
  }
  return out;
}

function main(): void {
  const [, , aPath, bPath] = process.argv;
  if (!aPath || !bPath) {
    console.error("usage: test262-canary-diff.ts <run-a.jsonl> <run-b.jsonl>");
    process.exit(2);
  }

  const a = loadResults(aPath);
  const b = loadResults(bPath);

  // Walk the union of file paths.
  const files = new Set<string>([...a.keys(), ...b.keys()]);

  // Categorise each test:
  //   - "match"    — same status in both runs
  //   - "flip"     — pass in one, non-pass in the other (the headline metric)
  //   - "noise"    — different non-pass statuses (e.g. fail↔compile_error);
  //                  meaningful only insofar as it shows non-determinism in
  //                  the failure path, separate from the pass↔fail metric
  //   - "missing"  — only in one of the two runs (probably a shard that
  //                  failed to upload an artifact; counted but reported)
  let match = 0;
  let flip = 0;
  let noise = 0;
  let missing = 0;
  const flippedFiles: { file: string; a: string; b: string }[] = [];
  const missingFiles: { file: string; only: "a" | "b"; status: string }[] = [];
  const noiseFiles: { file: string; a: string; b: string }[] = [];

  for (const file of files) {
    const sa = a.get(file);
    const sb = b.get(file);
    if (sa === undefined || sb === undefined) {
      missing++;
      missingFiles.push({
        file,
        only: sa === undefined ? "b" : "a",
        status: (sa ?? sb) as string,
      });
      continue;
    }
    if (sa === sb) {
      match++;
      continue;
    }
    const aPass = sa === "pass";
    const bPass = sb === "pass";
    if (aPass !== bPass) {
      flip++;
      flippedFiles.push({ file, a: sa, b: sb });
    } else {
      noise++;
      noiseFiles.push({ file, a: sa, b: sb });
    }
  }

  console.log("# Test262 canary diff");
  console.log("");
  console.log(`Run A: ${a.size} entries`);
  console.log(`Run B: ${b.size} entries`);
  console.log(`Union: ${files.size} unique test paths`);
  console.log("");
  console.log(`  Match (same status):                 ${match}`);
  console.log(`  Flip (pass <-> non-pass):            ${flip}    <-- THIS IS THE HEADLINE`);
  console.log(`  Noise (different non-pass statuses): ${noise}`);
  console.log(`  Missing (only in one run):           ${missing}`);
  console.log("");

  if (flip > 0) {
    console.log("## Flipped tests (top 20)");
    console.log("");
    for (const f of flippedFiles.slice(0, 20)) {
      console.log(`  ${f.file}: ${f.a} <-> ${f.b}`);
    }
    if (flippedFiles.length > 20) console.log(`  ... ${flippedFiles.length - 20} more`);
    console.log("");
  }

  if (noise > 0) {
    console.log("## Noise (different non-pass statuses, top 10)");
    console.log("");
    for (const f of noiseFiles.slice(0, 10)) {
      console.log(`  ${f.file}: ${f.a} <-> ${f.b}`);
    }
    if (noiseFiles.length > 10) console.log(`  ... ${noiseFiles.length - 10} more`);
    console.log("");
  }

  if (missing > 0) {
    console.log("## Missing in one run (top 10)");
    console.log("");
    for (const f of missingFiles.slice(0, 10)) {
      console.log(`  ${f.file}: only in run-${f.only === "a" ? "b" : "a"} (${f.status})`);
    }
    if (missingFiles.length > 10) console.log(`  ... ${missingFiles.length - 10} more`);
    console.log("");
  }

  // Last line — the CI step greps for this.
  console.log(`FLIP_COUNT=${flip}`);
}

main();
