// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Temporal Dead Zone (TDZ) helpers for module-level let/const variables.
 */
import type { Instr } from "../../ir/types.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { ensureExnTag } from "../registry/imports.js";

/**
 * Emit instructions to set a TDZ flag global to 1 (initialized) for a module-level
 * let/const variable. No-op if the variable doesn't have a TDZ flag.
 */
export function emitTdzInit(ctx: CodegenContext, fctx: FunctionContext, name: string): void {
  const flagIdx = ctx.tdzGlobals.get(name);
  if (flagIdx === undefined) return;
  fctx.body.push({ op: "i32.const", value: 1 });
  fctx.body.push({ op: "global.set", index: flagIdx });
}

/**
 * Emit a TDZ check for a module-level let/const variable read.
 * If the TDZ flag is 0 (uninitialized), throw a ReferenceError.
 * No-op if the variable doesn't have a TDZ flag.
 */
export function emitTdzCheck(ctx: CodegenContext, fctx: FunctionContext, name: string): void {
  const flagIdx = ctx.tdzGlobals.get(name);
  if (flagIdx === undefined) return;
  const tagIdx = ensureExnTag(ctx);
  // if (flag == 0) throw ReferenceError
  fctx.body.push({ op: "global.get", index: flagIdx });
  fctx.body.push({ op: "i32.eqz" });
  // if (uninitialized) { throw }
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [
      // Push error message as externref string, then throw
      emitTdzErrorString(ctx, name),
      { op: "throw", tagIdx },
    ],
    else: [],
  } as unknown as Instr);
}

/**
 * Build an instruction that pushes a ReferenceError message as externref onto the stack.
 * Uses ref.null.extern as the payload to avoid adding string constant imports that
 * would require the string_constants module at instantiation time (#790).
 * The exception is still catchable via try/catch.
 */
function emitTdzErrorString(_ctx: CodegenContext, _name: string): Instr {
  return { op: "ref.null.extern" } as Instr;
}
