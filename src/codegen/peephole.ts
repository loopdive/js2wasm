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
 *
 * 2. local.get N; drop — loading a local then immediately dropping it is a
 *    no-op (local.get has no side effects). Both instructions are removed.
 *      local.get N   ;; push value
 *      drop          ;; pop it — net effect: nothing. Removed.
 *
 * 3. local.tee N; drop — tee saves to local AND pushes a copy. If the pushed
 *    copy is immediately dropped, replace with local.set (save only, no push):
 *      local.tee N   ;; save + push
 *      drop          ;; pop the copy — replace with local.set N
 *
 * 4. Postfix increment/decrement dead-store: when i++ / x-- is used as a
 *    statement (result discarded), the compiler emits an extra local.get for
 *    the "expression result" that is immediately dropped after the update.
 *    Pattern (272 cases in corpus — #957):
 *      local.get N      ;; push old value (expression result — will be dropped)
 *      local.get N      ;; push N for computation
 *      i32/f64.const 1
 *      i32/f64.add/sub
 *      local.set N      ;; store incremented/decremented value
 *      drop             ;; drop old value — wasted push+drop pair
 *    Optimized:
 *      local.get N
 *      i32/f64.const 1
 *      i32/f64.add/sub
 *      local.set N
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

  // Scan for peephole patterns
  let i = 0;
  while (i < body.length - 1) {
    const cur = body[i]!;
    const next = body[i + 1]!;

    // Pattern 1: ref.cast followed by ref.as_non_null — remove the latter
    if (cur.op === "ref.cast" && next.op === "ref.as_non_null") {
      body.splice(i + 1, 1);
      removed++;
      // Don't increment i — check for multiple ref.as_non_null in a row
      continue;
    }

    // Pattern 2: local.get N; drop — dead load, remove both
    if (cur.op === "local.get" && next.op === "drop") {
      body.splice(i, 2);
      removed += 2;
      // Don't increment i — recheck at same position (new pair may have formed)
      continue;
    }

    // Pattern 3: local.tee N; drop — pushed copy is unused, replace with local.set
    if (cur.op === "local.tee" && next.op === "drop") {
      body.splice(i, 2, { op: "local.set", index: cur.index });
      removed++; // net: 2 removed, 1 added = 1 instruction saved
      i++;
      continue;
    }

    // Pattern 4: postfix increment/decrement dead-store (#957)
    // local.get N; local.get N; i32/f64.const 1; i32/f64.add/sub; local.set N; drop
    // → local.get N; i32/f64.const 1; i32/f64.add/sub; local.set N
    if (
      i + 5 < body.length &&
      cur.op === "local.get" &&
      body[i + 1]!.op === "local.get" &&
      (body[i + 1] as any).index === (cur as any).index &&
      (body[i + 2]!.op === "i32.const" || body[i + 2]!.op === "f64.const") &&
      (body[i + 3]!.op === "i32.add" ||
        body[i + 3]!.op === "i32.sub" ||
        body[i + 3]!.op === "f64.add" ||
        body[i + 3]!.op === "f64.sub") &&
      body[i + 4]!.op === "local.set" &&
      (body[i + 4] as any).index === (cur as any).index &&
      body[i + 5]!.op === "drop"
    ) {
      // Remove the first local.get N (index i) and the trailing drop (now at i+4 after removal)
      body.splice(i, 1); // remove first local.get N; array shifts left by 1
      body.splice(i + 4, 1); // remove drop (was i+5, now i+4 after first splice)
      removed += 2;
      // Don't increment i — recheck at same position
      continue;
    }

    i++;
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
