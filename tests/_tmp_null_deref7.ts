import { compile } from "../src/index.js";

// Same test but WITHOUT type annotations (like test262 JS)
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
console.log("Compile OK");

// Find buildImports
const imports: any = { env: {} };
if (result.imports) {
  for (const [name, imp] of Object.entries(result.imports)) {
    if (!imports.env[name]) {
      if (name === "__unbox_number") imports.env[name] = (v: unknown) => Number(v);
      else if (name === "__box_number") imports.env[name] = (v: number) => v;
      else if (name === "__extern_length") imports.env[name] = (v: any) => v?.length ?? 0;
      else imports.env[name] = (...args: any[]) => {};
    }
  }
}

WebAssembly.instantiate(result.binary, imports)
  .then(({ instance }) => {
    console.log("Result:", (instance.exports as any).test());
  })
  .catch((e: any) => console.log("Runtime error:", e.message));
