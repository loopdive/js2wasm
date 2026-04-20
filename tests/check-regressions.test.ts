import { test, expect } from "vitest";
import { assertEquivalent } from "./equivalence/helpers.js";

test("Array.prototype.every.call with named 3-param callback", async () => {
  const src = `
function callbackfn(val: any, idx: number, obj: any): boolean {
  if (idx === 0) {
    return val === 5;
  }
  return true;
}
var proto: any = {};
Object.defineProperty(proto, "0", { get: function() { return 5; }, configurable: true });
var Con = function(this: any) {};
(Con as any).prototype = proto;
var child: any = new Con();
child.length = 2;
Object.defineProperty(child, "0", { value: 11, configurable: true });
child[1] = 12;
export function test(): number { return Array.prototype.every.call(child, callbackfn) ? 1 : 0; }
  `;
  await assertEquivalent(src, [{ fn: "test", args: [] }]);
});

test("Object.create with inherited writable descriptor", async () => {
  const src = `
var proto: any = { writable: true };
var ConstructFun = function(this: any) {};
(ConstructFun as any).prototype = proto;
var descObj: any = new ConstructFun();
var newObj: any = Object.create({}, { prop: descObj });
var beforeWrite = (newObj.hasOwnProperty("prop") && typeof newObj.prop === "undefined");
newObj.prop = "isWritable";
var afterWrite = (newObj.prop === "isWritable");
export function test(): number { return (beforeWrite && afterWrite) ? 1 : 0; }
  `;
  await assertEquivalent(src, [{ fn: "test", args: [] }]);
});
