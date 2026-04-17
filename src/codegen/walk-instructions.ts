// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Shared utility for recursively walking Wasm instruction trees.
 *
 * Many passes need to visit every instruction in a body, recursing into
 * block/loop/if/try sub-bodies. This module provides a single implementation
 * so callers don't each duplicate the recursion logic.
 */
import type { Instr } from "../ir/types.js";

/**
 * Recursively walk all instructions in `instrs`, calling `visitor` on each one.
 * Automatically recurses into nested blocks: body, then, else, catches, catchAll.
 */
export function walkInstructions(instrs: Instr[], visitor: (instr: Instr) => void): void {
  for (const instr of instrs) {
    visitor(instr);
    walkChildren(instr, (child) => walkInstructions(child, visitor));
  }
}

/**
 * Invoke `fn` on every nested instruction array (body, then, else, catches, catchAll)
 * found on a single instruction. Does NOT recurse -- the caller is responsible for
 * driving recursion (e.g. by calling walkChildren again inside fn).
 */
export function walkChildren(instr: Instr, fn: (children: Instr[]) => void): void {
  const a = instr as any;
  if (a.body && Array.isArray(a.body)) fn(a.body);
  if (a.then && Array.isArray(a.then)) fn(a.then);
  if (a.else && Array.isArray(a.else)) fn(a.else);
  if (a.catches && Array.isArray(a.catches)) {
    for (const c of a.catches) {
      if (Array.isArray(c.body)) fn(c.body);
    }
  }
  if (a.catchAll && Array.isArray(a.catchAll)) fn(a.catchAll);
}
