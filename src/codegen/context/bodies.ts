// Copyright (c) 2026 Loopdive GmbH. Licensed under AGPL-3.0.
/**
 * Body stack helpers for nested code emission.
 *
 * This module owns the low-level mechanics for temporarily swapping a function
 * body while preserving enough state for late import index shifting.
 */
import type { Instr } from "../../ir/types.js";
import type { FunctionContext } from "./types.js";

export function pushBody(fctx: FunctionContext): Instr[] {
  const saved = fctx.body;
  fctx.savedBodies.push(saved);
  fctx.body = [];
  return saved;
}

export function popBody(fctx: FunctionContext, saved: Instr[]): void {
  fctx.savedBodies.pop();
  fctx.body = saved;
}
