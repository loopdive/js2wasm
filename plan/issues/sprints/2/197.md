---
id: 197
title: "Statement-level `if` compile errors"
status: done
created: 2026-03-11
updated: 2026-04-14
completed: 2026-03-11
goal: test-infrastructure
---
# #197 — Statement-level `if` compile errors

## Status: review

## Summary
7 test262 compile errors in `language/statements/if`. While 6 pass, the remaining errors prevent correct compilation of certain if-statement patterns.

## Motivation
7 compile errors. These likely involve:
- if statements with function declarations in branches
- if statements with complex expressions that can't be typed
- Nested if-else chains with scope issues

## Scope
- `src/codegen/statements.ts` — if statement codegen
- Function declarations inside if branches

## Complexity
S

## Acceptance criteria
- [ ] Function declarations in if branches compile
- [ ] 5+ test262 if-statement compile errors fixed

## Implementation notes
- Extended `hoistFunctionDeclarations` in `src/codegen/statements.ts` to recurse into if/else branches
- Function declarations inside if-branches are now properly hoisted to the enclosing function scope
- Also handles nested if-else chains and bare blocks
- Added equivalence tests for function-in-if and function-in-else patterns
