import { compile } from "../src/index.js";

const src = `
var callCount = 0;

class C {
  method([...x]: number[]): void {
    callCount = x.length;
  }
}

export function test(): number {
  new C().method([1, 2, 3]);
  return callCount;
}
`;

const result = compile(src);
if (!result.success) {
  console.log("Compile errors:");
  for (const e of result.errors) console.log("  L" + e.line + ": " + e.message);
  process.exit(1);
}
WebAssembly.instantiate(result.binary, { env: {} })
  .then(({ instance }) => {
    console.log("Result:", (instance.exports as any).test());
  })
  .catch((e: any) => console.log("Runtime error:", e.message));
