import { compile } from "../src/index.js";
const result = compile(`
  var callCount = 0;
  var C = class {
    method([x, y, z]: any = [1, 2, 3]) {
      callCount = callCount + 1;
    }
  };
  export function test(): number {
    new C().method();
    return callCount;
  }
`);
console.log("success:", result.success);
if (!result.success) {
  result.errors.forEach((e: any) => console.log("ERR:", e.message));
}
