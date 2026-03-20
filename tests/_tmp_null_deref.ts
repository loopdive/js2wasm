import { compile } from "../src/index.js";

const src = `
function process({ a = 10 }: { a?: number } = {}): number {
  return a;
}
export function test(): number {
  return process();
}
`;

const result = compile(src);
if (!result.success) {
  console.log("Compile errors:");
  for (const e of result.errors) console.log("  L" + e.line + ": " + e.message);
  process.exit(1);
}
WebAssembly.instantiate(result.binary, { env: {} }).then(({ instance }) => {
  console.log("Result:", (instance.exports as any).test());
}).catch((e: any) => console.log("Runtime error:", e.message));
