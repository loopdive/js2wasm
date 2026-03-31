import { compile } from "../src/index.js";

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

export function test(): number {
  try {
    var values = [1, 2, 3];
    var callCount: number = 0;
    class C {
      method([...x]) {
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
  for (const e of result.errors.slice(0, 5)) console.log("  L" + e.line + ": " + e.message);
  process.exit(1);
}

// Print the full WAT for the method function
const wat = result.wat || "";
const lines = wat.split("\n");
let inMethod = false;
let depth = 0;
for (const line of lines) {
  if (line.includes('"C_method"') || line.includes('"method"')) {
    inMethod = true;
  }
  if (inMethod) {
    console.log(line);
    depth += (line.match(/\(/g) || []).length - (line.match(/\)/g) || []).length;
    if (depth <= 0 && line.trim().startsWith(")")) {
      break;
    }
  }
}
