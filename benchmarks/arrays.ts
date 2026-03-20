import type { BenchmarkDef } from "../harness.js";

// ---------------------------------------------------------------------------
// JS baselines
// ---------------------------------------------------------------------------

function pushPop(): void {
  const arr: number[] = [];
  for (let i = 0; i < 100000; i++) arr.push(i);
  while (arr.length > 0) arr.pop();
}

function sortI32(): void {
  const arr: number[] = [];
  for (let i = 0; i < 10000; i++) arr.push((i * 37 + 13) % 10000);
  arr.sort((a, b) => a - b);
}

function sortF64(): void {
  const arr: number[] = [];
  for (let i = 0; i < 10000; i++) arr.push(Math.sin(i));
  arr.sort((a, b) => a - b);
}

function mapFilter(): void {
  const arr: number[] = [];
  for (let i = 0; i < 10000; i++) arr.push(i);
  const mapped = arr.map((x) => x * 2);
  const filtered = mapped.filter((x) => x % 3 === 0);
  void filtered.length;
}

function reduceSum(): void {
  const arr: number[] = [];
  for (let i = 0; i < 100000; i++) arr.push(i);
  const sum = arr.reduce((acc, x) => acc + x, 0);
  void sum;
}

function indexOfSearch(): void {
  const arr: number[] = [];
  for (let i = 0; i < 10000; i++) arr.push(i);
  let sum = 0;
  for (let i = 0; i < 1000; i++) sum += arr.indexOf(i * 10);
}

function sliceSplice(): void {
  const arr: number[] = [];
  for (let i = 0; i < 1000; i++) arr.push(i);
  for (let i = 0; i < 100; i++) {
    const sliced = arr.slice(100, 500);
    void sliced.length;
  }
}

function reverseArr(): void {
  const arr: number[] = [];
  for (let i = 0; i < 10000; i++) arr.push(i);
  for (let i = 0; i < 1000; i++) arr.reverse();
}

function forEachSum(): void {
  const arr: number[] = [];
  for (let i = 0; i < 10000; i++) arr.push(i);
  let sum = 0;
  arr.forEach((x) => {
    sum += x;
  });
}

function findElement(): void {
  const arr: number[] = [];
  for (let i = 0; i < 10000; i++) arr.push(i);
  let sum = 0;
  for (let i = 0; i < 100; i++) {
    const found = arr.find((x) => x === 5000);
    if (found !== undefined) sum += found;
  }
}

// ---------------------------------------------------------------------------
// Benchmark definitions
// ---------------------------------------------------------------------------

export const arrayBenchmarks: BenchmarkDef[] = [
  {
    name: "array/push-pop",
    iterations: 50,
    source: `
export function run(): number {
  const arr: number[] = [];
  for (let i = 0; i < 100000; i = i + 1) {
    arr.push(i);
  }
  let count = 0;
  while (arr.length > 0) {
    arr.pop();
    count = count + 1;
  }
  return count;
}`,
    js: pushPop,
  },
  {
    name: "array/sort-i32",
    iterations: 20,
    source: `
export function run(): number {
  const arr: number[] = [];
  for (let i = 0; i < 10000; i = i + 1) {
    arr.push((i * 37 + 13) % 10000);
  }
  arr.sort();
  return arr[0];
}`,
    js: sortI32,
  },
  {
    name: "array/map-filter",
    iterations: 50,
    source: `
export function run(): number {
  const arr: number[] = [];
  for (let i = 0; i < 10000; i = i + 1) {
    arr.push(i);
  }
  const mapped = arr.map((x: number): number => x * 2);
  const filtered = mapped.filter((x: number): boolean => x % 3 === 0);
  return filtered.length;
}`,
    js: mapFilter,
  },
  {
    name: "array/reduce",
    iterations: 50,
    source: `
export function run(): number {
  const arr: number[] = [];
  for (let i = 0; i < 100000; i = i + 1) {
    arr.push(i);
  }
  return arr.reduce((acc: number, x: number): number => acc + x, 0);
}`,
    js: reduceSum,
  },
  {
    name: "array/indexOf",
    iterations: 50,
    source: `
export function run(): number {
  const arr: number[] = [];
  for (let i = 0; i < 10000; i = i + 1) {
    arr.push(i);
  }
  let sum = 0;
  for (let i = 0; i < 1000; i = i + 1) {
    sum = sum + arr.indexOf(i * 10);
  }
  return sum;
}`,
    js: indexOfSearch,
  },
  {
    name: "array/slice",
    iterations: 100,
    source: `
export function run(): number {
  const arr: number[] = [];
  for (let i = 0; i < 1000; i = i + 1) {
    arr.push(i);
  }
  let total = 0;
  for (let i = 0; i < 100; i = i + 1) {
    const sliced = arr.slice(100, 500);
    total = total + sliced.length;
  }
  return total;
}`,
    js: sliceSplice,
  },
  {
    name: "array/reverse",
    iterations: 50,
    source: `
export function run(): number {
  const arr: number[] = [];
  for (let i = 0; i < 10000; i = i + 1) {
    arr.push(i);
  }
  for (let i = 0; i < 1000; i = i + 1) {
    arr.reverse();
  }
  return arr[0];
}`,
    js: reverseArr,
  },
  {
    name: "array/forEach",
    iterations: 50,
    source: `
export function run(): number {
  const arr: number[] = [];
  for (let i = 0; i < 10000; i = i + 1) {
    arr.push(i);
  }
  let sum = 0;
  arr.forEach((x: number): void => {
    sum = sum + x;
  });
  return sum;
}`,
    js: forEachSum,
  },
  {
    name: "array/find",
    iterations: 50,
    source: `
export function run(): number {
  const arr: number[] = [];
  for (let i = 0; i < 10000; i = i + 1) {
    arr.push(i);
  }
  let sum = 0;
  for (let i = 0; i < 100; i = i + 1) {
    const found = arr.find((x: number): boolean => x === 5000);
    if (found !== undefined) sum = sum + found;
  }
  return sum;
}`,
    js: findElement,
    skip: ["gc-native"], // find with undefined check may not work in fast mode
  },
];
