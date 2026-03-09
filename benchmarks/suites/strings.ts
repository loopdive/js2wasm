import type { BenchmarkDef } from "../harness.js";

// ---------------------------------------------------------------------------
// Helpers for JS baselines
// ---------------------------------------------------------------------------

function concatShort(): void {
  let s = "";
  for (let i = 0; i < 10000; i++) s = s + "hello world!!!!";
}

function concatLong(): void {
  const chunk = "x".repeat(1024);
  let s = "";
  for (let i = 0; i < 1000; i++) s = s + chunk;
}

function searchIndexOf(): void {
  const haystack = "abcdefghij".repeat(1000);
  let sum = 0;
  for (let i = 0; i < 1000; i++) {
    sum = sum + haystack.indexOf("fghij");
  }
}

function searchIncludes(): void {
  const haystack = "abcdefghij".repeat(1000);
  let count = 0;
  for (let i = 0; i < 1000; i++) {
    if (haystack.includes("fghij")) count = count + 1;
  }
}

function splitJoin(): void {
  const csv = "alpha,bravo,charlie,delta,echo,foxtrot,golf,hotel";
  let sum = 0;
  for (let i = 0; i < 10000; i++) {
    const parts = csv.split(",");
    sum = sum + parts.length;
  }
}

function replaceAll(): void {
  const text = "the quick brown fox jumps over the lazy dog";
  let s = "";
  for (let i = 0; i < 1000; i++) {
    s = text.replace("fox", "cat");
  }
}

function caseConvert(): void {
  const s = "Hello World Test String";
  let r = "";
  for (let i = 0; i < 1000; i++) {
    r = s.toLowerCase();
    r = s.toUpperCase();
  }
}

function substringExtract(): void {
  const s = "abcdefghijklmnopqrstuvwxyz";
  let r = "";
  for (let i = 0; i < 10000; i++) {
    r = s.substring(5, 20);
  }
}

function trimOps(): void {
  const s = "   hello world   ";
  let r = "";
  for (let i = 0; i < 10000; i++) {
    r = s.trim();
  }
}

function startsEndsWith(): void {
  const s = "hello world, this is a test string for benchmarking";
  let count = 0;
  for (let i = 0; i < 10000; i++) {
    if (s.startsWith("hello")) count = count + 1;
    if (s.endsWith("benchmarking")) count = count + 1;
  }
}

// ---------------------------------------------------------------------------
// Benchmark definitions
// ---------------------------------------------------------------------------

export const stringBenchmarks: BenchmarkDef[] = [
  {
    name: "string/concat-short",
    iterations: 50,
    source: `
export function run(): number {
  let s = "";
  for (let i = 0; i < 10000; i = i + 1) {
    s = s + "hello world!!!!";
  }
  return s.length;
}`,
    js: concatShort,
  },
  {
    name: "string/concat-long",
    iterations: 50,
    source: `
export function run(): number {
  const chunk = "x".repeat(1024);
  let s = "";
  for (let i = 0; i < 1000; i = i + 1) {
    s = s + chunk;
  }
  return s.length;
}`,
    js: concatLong,
  },
  {
    name: "string/indexOf",
    iterations: 50,
    source: `
export function run(): number {
  const haystack = "abcdefghij".repeat(1000);
  let sum = 0;
  for (let i = 0; i < 1000; i = i + 1) {
    sum = sum + haystack.indexOf("fghij");
  }
  return sum;
}`,
    js: searchIndexOf,
  },
  {
    name: "string/includes",
    iterations: 50,
    source: `
export function run(): number {
  const haystack = "abcdefghij".repeat(1000);
  let count = 0;
  for (let i = 0; i < 1000; i = i + 1) {
    if (haystack.includes("fghij")) count = count + 1;
  }
  return count;
}`,
    js: searchIncludes,
  },
  {
    name: "string/split",
    iterations: 50,
    source: `
export function run(): number {
  const csv = "alpha,bravo,charlie,delta,echo,foxtrot,golf,hotel";
  let sum = 0;
  for (let i = 0; i < 10000; i = i + 1) {
    const parts = csv.split(",");
    sum = sum + parts.length;
  }
  return sum;
}`,
    js: splitJoin,
  },
  {
    name: "string/replace",
    iterations: 100,
    source: `
export function run(): number {
  const text = "the quick brown fox jumps over the lazy dog";
  let s = "";
  for (let i = 0; i < 1000; i = i + 1) {
    s = text.replace("fox", "cat");
  }
  return s.length;
}`,
    js: replaceAll,
  },
  {
    name: "string/case-convert",
    iterations: 100,
    source: `
export function run(): number {
  const s = "Hello World Test String";
  let r = "";
  for (let i = 0; i < 1000; i = i + 1) {
    r = s.toLowerCase();
    r = s.toUpperCase();
  }
  return r.length;
}`,
    js: caseConvert,
  },
  {
    name: "string/substring",
    iterations: 100,
    source: `
export function run(): number {
  const s = "abcdefghijklmnopqrstuvwxyz";
  let r = "";
  for (let i = 0; i < 10000; i = i + 1) {
    r = s.substring(5, 20);
  }
  return r.length;
}`,
    js: substringExtract,
  },
  {
    name: "string/trim",
    iterations: 100,
    source: `
export function run(): number {
  const s = "   hello world   ";
  let r = "";
  for (let i = 0; i < 10000; i = i + 1) {
    r = s.trim();
  }
  return r.length;
}`,
    js: trimOps,
  },
  {
    name: "string/startsWith-endsWith",
    iterations: 100,
    source: `
export function run(): number {
  const s = "hello world, this is a test string for benchmarking";
  let count = 0;
  for (let i = 0; i < 10000; i = i + 1) {
    if (s.startsWith("hello")) count = count + 1;
    if (s.endsWith("benchmarking")) count = count + 1;
  }
  return count;
}`,
    js: startsEndsWith,
  },
];
