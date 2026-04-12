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
 *
 * 5. ref.test T + if(then [local.get N; ref.cast T; ...]) when local N is (ref_null T)
 *    (#955): ref.test already proves the value is non-null and of type T, making the
 *    subsequent ref.cast T a runtime no-op.  Replace ref.cast with ref.as_non_null
 *    (saves 2+ bytes; valid because (ref_null T) + ref.as_non_null → (ref T)):
 *      local.get N         ;; (ref_null T) local
 *      ref.test (ref T)    ;; proved: non-null, type T
 *      if (then
 *        local.get N
 *        ref.cast (ref T)  ;; redundant — replace with ref.as_non_null (1 byte)
 *        ...
 *      )
 */
import type { Instr, WasmModule, ValType } from "../ir/types.js";

/**
 * Remove redundant ref.as_non_null after ref.cast in a single instruction list.
 * Recurses into block, loop, if/then/else, and try/catch bodies.
 * Mutates the array in place and returns the number of instructions removed.
 *
 * @param localTypes - flat array of Wasm types for locals in the enclosing function:
 *   indices [0..numParams-1] are param types, [numParams..] are declared locals.
 *   Used by Pattern 5 to look up whether a local is (ref_null T).
 */
function optimizeBody(body: Instr[], localTypes?: ValType[]): number {
  let removed = 0;

  // First, recurse into nested blocks
  for (const instr of body) {
    switch (instr.op) {
      case "block":
      case "loop":
        if (instr.body) removed += optimizeBody(instr.body, localTypes);
        break;
      case "if":
        if (instr.then) removed += optimizeBody(instr.then, localTypes);
        if (instr.else) removed += optimizeBody(instr.else, localTypes);
        break;
      case "try":
        if (instr.body) removed += optimizeBody(instr.body as Instr[], localTypes);
        if ((instr as any).catches) {
          for (const c of (instr as any).catches) {
            if (c.body) removed += optimizeBody(c.body, localTypes);
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

    // Pattern 5: local.get N; ref.test T; if (then [local.get N; ref.cast T; ...rest]) (#955)
    // When local N is of type (ref_null T), the ref.test already proved non-null and
    // correct type, so ref.cast T is redundant for the runtime check.
    // Replace ref.cast T with ref.as_non_null (1 byte vs 3+ bytes, preserves (ref T) type).
    // Only valid when the local is (ref_null T) — ref.as_non_null on anyref would give (ref any).
    if (
      localTypes &&
      i + 2 < body.length &&
      cur.op === "local.get" &&
      next.op === "ref.test" &&
      body[i + 2]!.op === "if"
    ) {
      const localIdx = (cur as any).index as number;
      const testTypeIdx = (next as any).typeIdx as number;
      const ifInstr = body[i + 2]!;
      const localType = localTypes[localIdx];
      // Check: local is (ref_null T) where T matches the ref.test type
      if (
        localType &&
        localType.kind === "ref_null" &&
        (localType as any).typeIdx === testTypeIdx &&
        (ifInstr as any).then &&
        (ifInstr as any).then.length >= 2 &&
        (ifInstr as any).then[0].op === "local.get" &&
        (ifInstr as any).then[0].index === localIdx &&
        (ifInstr as any).then[1].op === "ref.cast" &&
        (ifInstr as any).then[1].typeIdx === testTypeIdx
      ) {
        // Replace ref.cast T with ref.as_non_null in the then branch
        (ifInstr as any).then[1] = { op: "ref.as_non_null" };
        removed++; // net: ref.cast (3+ bytes) → ref.as_non_null (1 byte)
        i++;
        continue;
      }
    }

    i++;
  }

  return removed;
}

/**
 * Resolve param types for a function from the module's type table.
 * Returns an empty array if the type cannot be found or is not a func type.
 */
function getFuncParamTypes(mod: WasmModule, typeIdx: number): ValType[] {
  const typeDef = mod.types[typeIdx];
  if (!typeDef) return [];
  // Direct function type
  if (typeDef.kind === "func") return typeDef.params;
  // Sub type wrapping a func type
  if (typeDef.kind === "sub" && typeDef.type.kind === "func") return typeDef.type.params;
  return [];
}

/**
 * Run peephole optimizations on all function bodies in a WasmModule.
 * Returns the total number of instructions eliminated.
 */
export function peepholeOptimize(mod: WasmModule): number {
  let totalRemoved = 0;
  for (const func of mod.functions) {
    // Build flat local-type array: params first, then declared locals
    const paramTypes = getFuncParamTypes(mod, func.typeIdx);
    const localTypes: ValType[] = [...paramTypes, ...func.locals.map((l) => l.type)];
    totalRemoved += optimizeBody(func.body, localTypes);
  }
  return totalRemoved;
}
