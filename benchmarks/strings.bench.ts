import { bench, describe } from "vitest";
import { compileAndRun, tryCompileAndRun } from "./bench-harness.js";

// ---------------------------------------------------------------------------
// concat-short: Concatenate 100 short strings
// ---------------------------------------------------------------------------

const concatSource = `
export function run(): number {
  let s = "";
  for (let i = 0; i < 100; i++) {
    s = s + "ab";
  }
  return s.length;
}
`;

describe("concat-short", async () => {
  const hostExports = await tryCompileAndRun(concatSource, { fast: false });
  const gcExports = await tryCompileAndRun(concatSource, { fast: true });

  bench("js", () => {
    let s = "";
    for (let i = 0; i < 100; i++) s += "ab";
    void s.length;
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
// indexOf: Search in a long string
// ---------------------------------------------------------------------------

const indexOfSource = `
export function run(): number {
  let s = "";
  for (let i = 0; i < 100; i++) {
    s = s + "abcdefghij";
  }
  let found = 0;
  for (let i = 0; i < 50; i++) {
    if (s.indexOf("fgh") >= 0) {
      found = found + 1;
    }
  }
  return found;
}
`;

describe("string-indexOf", async () => {
  const hostExports = await tryCompileAndRun(indexOfSource, { fast: false });
  const gcExports = await tryCompileAndRun(indexOfSource, { fast: true });

  bench("js", () => {
    let s = "";
    for (let i = 0; i < 100; i++) s += "abcdefghij";
    let found = 0;
    for (let i = 0; i < 50; i++) {
      if (s.indexOf("fgh") >= 0) found++;
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

// ---------------------------------------------------------------------------
// substring: Extract substrings repeatedly
// ---------------------------------------------------------------------------

const substringSource = `
export function run(): number {
  let s = "";
  for (let i = 0; i < 50; i++) {
    s = s + "abcdefghij";
  }
  let totalLen = 0;
  for (let i = 0; i < 100; i++) {
    const sub = s.substring(i, i + 10);
    totalLen = totalLen + sub.length;
  }
  return totalLen;
}
`;

describe("substring", async () => {
  const hostExports = await tryCompileAndRun(substringSource, { fast: false });
  const gcExports = await tryCompileAndRun(substringSource, { fast: true });

  bench("js", () => {
    let s = "";
    for (let i = 0; i < 50; i++) s += "abcdefghij";
    let totalLen = 0;
    for (let i = 0; i < 100; i++) {
      const sub = s.substring(i, i + 10);
      totalLen += sub.length;
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
