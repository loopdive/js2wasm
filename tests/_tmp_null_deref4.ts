import { compile } from "../src/index.js";
import { wrapTest } from "./test262-runner.js";

const src = `
var values = [1, 2, 3];
var callCount = 0;
class C {
  method([...x]) {
    assert.sameValue(x.length, 3);
    assert.sameValue(x[0], 1);
    callCount = callCount + 1;
  }
};
new C().method(values);
assert.sameValue(callCount, 1);
`;

const wrapped = wrapTest(src);
console.log("WRAPPED SOURCE:");
console.log(wrapped);
console.log("\n\n");

const result = compile(wrapped);
if (!result.success) {
  console.log("Compile errors:");
  for (const e of result.errors) console.log("  L" + e.line + ": " + e.message);
  process.exit(1);
}
console.log("Compile OK, instantiating...");
WebAssembly.instantiate(result.binary, { env: {} })
  .then(({ instance }) => {
    console.log("Result:", (instance.exports as any).test());
  })
  .catch((e: any) => console.log("Runtime error:", e.message));
