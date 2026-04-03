/**
 * Source position helpers for debug/source-map aware code emission.
 */
import ts from "typescript";
import type { Instr } from "../../ir/types.js";
import type { CodegenContext, SourcePos } from "./types.js";

export function getSourcePos(ctx: CodegenContext, node: ts.Node): SourcePos | undefined {
  if (!ctx.sourceMap) return undefined;
  try {
    const sf = node.getSourceFile();
    if (!sf) return undefined;
    const pos = sf.getLineAndCharacterOfPosition(node.getStart());
    return { file: sf.fileName, line: pos.line, column: pos.character };
  } catch {
    return undefined;
  }
}

export function attachSourcePos(instr: Instr, sourcePos: SourcePos | undefined): Instr {
  if (sourcePos) {
    (instr as Instr).sourcePos = sourcePos;
  }
  return instr;
}
