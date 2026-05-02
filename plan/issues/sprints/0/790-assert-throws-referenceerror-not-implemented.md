---
id: 790
title: "- assert.throws(ReferenceError) not implemented (788 tests)"
status: done
created: 2026-03-26
updated: 2026-04-14
completed: 2026-03-26
priority: high
feasibility: medium
goal: error-model
test262_fail: 788
commit: 3d6abd6b, c7573440
---
# #790 -- assert.throws(ReferenceError) not implemented (788 tests)

## Implementation summary

Emit ReferenceError for TDZ violations and undeclared variable access. `hoistVarDeclarations` exported for IIFE TDZ hoisting (3d6abd6b). ReferenceError thrown for TDZ violations in IIFEs and undeclared variables (c7573440).

## Files modified
- `src/codegen/expressions.ts` — variable resolution, TDZ guard emission
- `src/codegen/statements.ts` — let/const initialization tracking, hoistVarDeclarations export
