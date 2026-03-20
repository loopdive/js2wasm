import type { BenchmarkDef } from "../harness.js";

// ---------------------------------------------------------------------------
// JS baselines
// ---------------------------------------------------------------------------

function csvParse(): void {
  const csv =
    "name,age,city\nAlice,30,Berlin\nBob,25,Munich\nCharlie,35,Hamburg\n" +
    "Diana,28,Cologne\nEve,32,Frankfurt\nFrank,29,Stuttgart\nGrace,31,Leipzig\n" +
    "Hank,27,Dresden\nIvy,33,Bonn\nJack,26,Essen";
  for (let iter = 0; iter < 1000; iter++) {
    const lines = csv.split("\n");
    let sum = 0;
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i]!.split(",");
      sum += cols.length;
    }
  }
}

function textSearch(): void {
  const text =
    "The quick brown fox jumps over the lazy dog. " +
    "Pack my box with five dozen liquor jugs. " +
    "How vexingly quick daft zebras jump. " +
    "The five boxing wizards jump quickly.";
  const needle = "jump";
  for (let iter = 0; iter < 10000; iter++) {
    let count = 0;
    if (text.includes(needle)) count++;
    if (text.startsWith("The")) count++;
    if (text.endsWith("quickly.")) count++;
    const idx = text.indexOf(needle);
    if (idx >= 0) count++;
  }
}

function fibonacci(): void {
  function fib(n: number): number {
    if (n <= 1) return n;
    let a = 0,
      b = 1;
    for (let i = 2; i <= n; i++) {
      const t = a + b;
      a = b;
      b = t;
    }
    return b;
  }
  for (let i = 0; i < 10000; i++) fib(30);
}

function matrixMultiply(): void {
  const N = 50;
  const a: number[] = [];
  const b: number[] = [];
  const c: number[] = [];
  for (let i = 0; i < N * N; i++) {
    a.push(i);
    b.push(N * N - i);
    c.push(0);
  }
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      let sum = 0;
      for (let k = 0; k < N; k++) {
        sum += a[i * N + k]! * b[k * N + j]!;
      }
      c[i * N + j] = sum;
    }
  }
}

function sieve(): void {
  const N = 100000;
  const isPrime: number[] = [];
  for (let i = 0; i < N; i++) isPrime.push(1);
  isPrime[0] = 0;
  isPrime[1] = 0;
  for (let i = 2; i * i < N; i++) {
    if (isPrime[i]) {
      for (let j = i * i; j < N; j += i) {
        isPrime[j] = 0;
      }
    }
  }
  let count = 0;
  for (let i = 0; i < N; i++) {
    if (isPrime[i]) count++;
  }
}

// ---------------------------------------------------------------------------
// Benchmark definitions
// ---------------------------------------------------------------------------

export const mixedBenchmarks: BenchmarkDef[] = [
  {
    name: "mixed/csv-parse",
    iterations: 20,
    source: `
export function run(): number {
  const csv = "name,age,city\\nAlice,30,Berlin\\nBob,25,Munich\\nCharlie,35,Hamburg\\nDiana,28,Cologne\\nEve,32,Frankfurt\\nFrank,29,Stuttgart\\nGrace,31,Leipzig\\nHank,27,Dresden\\nIvy,33,Bonn\\nJack,26,Essen";
  let total = 0;
  for (let iter = 0; iter < 1000; iter = iter + 1) {
    const lines = csv.split("\\n");
    let sum = 0;
    for (let i = 1; i < lines.length; i = i + 1) {
      const cols = lines[i].split(",");
      sum = sum + cols.length;
    }
    total = total + sum;
  }
  return total;
}`,
    js: csvParse,
  },
  {
    name: "mixed/text-search",
    iterations: 20,
    source: `
export function run(): number {
  const text = "The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs. How vexingly quick daft zebras jump. The five boxing wizards jump quickly.";
  const needle = "jump";
  let total = 0;
  for (let iter = 0; iter < 10000; iter = iter + 1) {
    let count = 0;
    if (text.includes(needle)) count = count + 1;
    if (text.startsWith("The")) count = count + 1;
    if (text.endsWith("quickly.")) count = count + 1;
    const idx = text.indexOf(needle);
    if (idx >= 0) count = count + 1;
    total = total + count;
  }
  return total;
}`,
    js: textSearch,
  },
  {
    name: "mixed/fibonacci",
    iterations: 50,
    source: `
function fib(n: number): number {
  if (n <= 1) return n;
  let a = 0;
  let b = 1;
  for (let i = 2; i <= n; i = i + 1) {
    const t = a + b;
    a = b;
    b = t;
  }
  return b;
}

export function run(): number {
  let sum = 0;
  for (let i = 0; i < 10000; i = i + 1) {
    sum = sum + fib(30);
  }
  return sum;
}`,
    js: fibonacci,
  },
  {
    name: "mixed/matrix-multiply",
    iterations: 50,
    source: `
export function run(): number {
  const N = 50;
  const a: number[] = [];
  const b: number[] = [];
  const c: number[] = [];
  for (let i = 0; i < N * N; i = i + 1) {
    a.push(i);
    b.push(N * N - i);
    c.push(0);
  }
  for (let i = 0; i < N; i = i + 1) {
    for (let j = 0; j < N; j = j + 1) {
      let sum = 0;
      for (let k = 0; k < N; k = k + 1) {
        sum = sum + a[i * N + k] * b[k * N + j];
      }
      c[i * N + j] = sum;
    }
  }
  return c[0];
}`,
    js: matrixMultiply,
  },
  {
    name: "mixed/sieve",
    iterations: 20,
    source: `
export function run(): number {
  const N = 100000;
  const isPrime: number[] = [];
  for (let i = 0; i < N; i = i + 1) {
    isPrime.push(1);
  }
  isPrime[0] = 0;
  isPrime[1] = 0;
  for (let i = 2; i * i < N; i = i + 1) {
    if (isPrime[i] === 1) {
      for (let j = i * i; j < N; j = j + i) {
        isPrime[j] = 0;
      }
    }
  }
  let count = 0;
  for (let i = 0; i < N; i = i + 1) {
    if (isPrime[i] === 1) count = count + 1;
  }
  return count;
}`,
    js: sieve,
  },
];
