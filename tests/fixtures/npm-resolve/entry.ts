import { add } from "simple-math";
import { helper } from "./lib/helper";

export function run(a: number, b: number): number {
  return helper(add(a, b));
}
