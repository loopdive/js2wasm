import { bench, describe } from "vitest";
import { compileAndRun, tryCompileAndRun } from "./bench-harness.js";

// ---------------------------------------------------------------------------
// push-iterate: Push 10k elements, then iterate and sum
// ---------------------------------------------------------------------------

const pushIterateSource = `
export function run(): number {
  const arr: number[] = [];
  for (let i = 0; i < 10000; i++) {
    arr.push(i);
  }
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    sum = sum + arr[i];
  }
  return sum;
}
`;

describe("push-iterate", async () => {
  const hostExports = await tryCompileAndRun(pushIterateSource, { fast: false });
  const gcExports = await tryCompileAndRun(pushIterateSource, { fast: true });

  bench("js", () => {
    const arr: number[] = [];
    for (let i = 0; i < 10000; i++) arr.push(i);
    let sum = 0;
    for (let i = 0; i < arr.length; i++) sum += arr[i];
  });

  if (hostExports) {
    bench("host-call", () => {
      (hostExports.run as Function)();
    });
  }

  if (gcExports) {
    bench("gc-native", () => {
      (gcExports.run as Function)();
    });
  }
});

// ---------------------------------------------------------------------------
// map-filter: Map then filter a 1k-element array
// ---------------------------------------------------------------------------

const mapFilterSource = `
export function run(): number {
  const arr: number[] = [];
  for (let i = 0; i < 1000; i++) {
    arr.push(i);
  }
  const doubled = arr.map((x: number): number => x * 2);
  const evens = doubled.filter((x: number): boolean => x % 4 === 0);
  return evens.length;
}
`;

describe("map-filter", async () => {
  const hostExports = await tryCompileAndRun(mapFilterSource, { fast: false });
  const gcExports = await tryCompileAndRun(mapFilterSource, { fast: true });

  bench("js", () => {
    const arr: number[] = [];
    for (let i = 0; i < 1000; i++) arr.push(i);
    const doubled = arr.map((x) => x * 2);
    const evens = doubled.filter((x) => x % 4 === 0);
    void evens.length;
  });

  if (hostExports) {
    bench("host-call", () => {
      (hostExports.run as Function)();
    });
  }

  if (gcExports) {
    bench("gc-native", () => {
      (gcExports.run as Function)();
    });
  }
});

// ---------------------------------------------------------------------------
// sum: Sum 10k elements using a for loop
// ---------------------------------------------------------------------------

const sumSource = `
export function run(): number {
  const arr: number[] = [];
  for (let i = 0; i < 10000; i++) {
    arr.push(i);
  }
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    sum = sum + arr[i];
  }
  return sum;
}
`;

describe("sum-10k", async () => {
  const hostExports = await tryCompileAndRun(sumSource, { fast: false });
  const gcExports = await tryCompileAndRun(sumSource, { fast: true });

  bench("js", () => {
    const arr: number[] = [];
    for (let i = 0; i < 10000; i++) arr.push(i);
    let sum = 0;
    for (let i = 0; i < arr.length; i++) sum += arr[i];
  });

  if (hostExports) {
    bench("host-call", () => {
      (hostExports.run as Function)();
    });
  }

  if (gcExports) {
    bench("gc-native", () => {
      (gcExports.run as Function)();
    });
  }
});

// ---------------------------------------------------------------------------
// indexOf: Search in a 1k array
// ---------------------------------------------------------------------------

const indexOfSource = `
export function run(): number {
  const arr: number[] = [];
  for (let i = 0; i < 1000; i++) {
    arr.push(i);
  }
  let found = 0;
  for (let i = 0; i < 100; i++) {
    if (arr.indexOf(i * 10) >= 0) {
      found = found + 1;
    }
  }
  return found;
}
`;

describe("indexOf", async () => {
  const hostExports = await tryCompileAndRun(indexOfSource, { fast: false });
  const gcExports = await tryCompileAndRun(indexOfSource, { fast: true });

  bench("js", () => {
    const arr: number[] = [];
    for (let i = 0; i < 1000; i++) arr.push(i);
    let found = 0;
    for (let i = 0; i < 100; i++) {
      if (arr.indexOf(i * 10) >= 0) found++;
    }
  });

  if (hostExports) {
    bench("host-call", () => {
      (hostExports.run as Function)();
    });
  }

  if (gcExports) {
    bench("gc-native", () => {
      (gcExports.run as Function)();
    });
  }
});
