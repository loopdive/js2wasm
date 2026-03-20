import { compile } from "../src/index.js";

const src = `
function f([a, b, c]: number[]): number {
  return a + b + c;
}
export function test(): number {
  return f([10, 20, 30]);
}
`;

const result = compile(src);
if (!result.success) {
  console.log("Compile errors:");
  for (const e of result.errors) console.log("  L" + e.line + ": " + e.message);
  // Show WAT
  console.log("WAT:", result.wat?.substring(0, 2000));
  process.exit(1);
}
WebAssembly.instantiate(result.binary, { env: {} }).then(({ instance }) => {
  console.log("Result:", (instance.exports as any).test());
}).catch((e: any) => console.log("Runtime error:", e.message));
