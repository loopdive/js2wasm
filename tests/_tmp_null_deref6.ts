import { compile } from "../src/index.js";

// Simpler test - function with array destructuring, no type annotations
const src = `
let __fail: number = 0;
function isSameValue(a: number, b: number): number {
  if (a === b) { return 1; }
  if (a !== a && b !== b) { return 1; }
  return 0;
}
function assert_sameValue(actual: number, expected: number): void {
  if (!isSameValue(actual, expected)) { __fail = 1; }
}
function assert_true(value: number): void {
  if (!value) { __fail = 1; }
}

export function test(): number {
  try {
    var values = [1, 2, 3];
    var callCount: number = 0;
    class C {
      method([...x]: number[]): void {
        assert_sameValue(x.length, 3);
        assert_sameValue(x[0], 1);
        callCount = callCount + 1;
      }
    };
    new C().method(values);
    assert_sameValue(callCount, 1);
  } catch (e) {
    __fail = 1;
  }
  if (__fail) { return 0; }
  return 1;
}
`;

const result = compile(src);
if (!result.success) {
  console.log("Compile errors:");
  for (const e of result.errors) console.log("  L" + e.line + ": " + e.message);
  process.exit(1);
}

// Extract WAT around struct.get
const wat = result.wat || '';
const lines = wat.split('\n');
let found = false;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('struct.get') || lines[i].includes('ref.is_null')) {
    // Print context
    const start = Math.max(0, i - 3);
    const end = Math.min(lines.length, i + 4);
    for (let j = start; j < end; j++) {
      console.log((j === i ? '>>> ' : '    ') + lines[j]);
    }
    console.log('---');
    found = true;
  }
}
if (!found) console.log("No struct.get found in WAT");
