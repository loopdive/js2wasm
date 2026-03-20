import { compile } from "../src/index.js";
import { wrapTest, createImports } from "./test262-runner.js";

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
const result = compile(wrapped);
if (!result.success) {
  console.log("Compile errors:");
  for (const e of result.errors) console.log("  L" + e.line + ": " + e.message);
  process.exit(1);
}
console.log("Compile OK, instantiating...");
