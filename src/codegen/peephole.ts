/**
 * Peephole optimization pass for Wasm function bodies.
 *
 * Eliminates redundant instructions that are provably unnecessary:
 *
 * 1. ref.as_non_null after ref.cast — ref.cast (opcode 0x16) already produces
 *    a non-null reference, so the subsequent ref.as_non_null is redundant.
 *    This pattern appears frequently at closure call sites:
 *      struct.get $closure 0
 *      ref.cast $funcType      ;; already non-null
 *      ref.as_non_null         ;; redundant — removed
 *      call_ref $funcType
 */
import type { Instr, WasmModule } from "../ir/types.js";

/**
 * Remove redundant ref.as_non_null after ref.cast in a single instruction list.
 * Recurses into block, loop, if/then/else, and try/catch bodies.
 * Mutates the array in place and returns the number of instructions removed.
 */
function optimizeBody(body: Instr[]): number {
  let removed = 0;

  // First, recurse into nested blocks
  for (const instr of body) {
    switch (instr.op) {
      case "block":
      case "loop":
        if (instr.body) removed += optimizeBody(instr.body);
        break;
      case "if":
        if (instr.then) removed += optimizeBody(instr.then);
        if (instr.else) removed += optimizeBody(instr.else);
        break;
      case "try":
        if (instr.body) removed += optimizeBody(instr.body as Instr[]);
        if ((instr as any).catches) {
          for (const c of (instr as any).catches) {
            if (c.body) removed += optimizeBody(c.body);
          }
        }
        break;
    }
  }

  // Now scan for ref.cast followed by ref.as_non_null and remove the latter
  let i = 0;
  while (i < body.length - 1) {
    if (body[i]!.op === "ref.cast" && body[i + 1]!.op === "ref.as_non_null") {
      body.splice(i + 1, 1);
      removed++;
      // Don't increment i — check if there are multiple ref.as_non_null in a row
    } else {
      i++;
    }
  }

  return removed;
}

/**
 * Run peephole optimizations on all function bodies in a WasmModule.
 * Returns the total number of instructions eliminated.
 */
export function peepholeOptimize(mod: WasmModule): number {
  let totalRemoved = 0;
  for (const func of mod.functions) {
    totalRemoved += optimizeBody(func.body);
  }
  return totalRemoved;
}
