---
name: project_next_session
description: 2026-03-22 session state — expressions.ts refactored, 4 regressions to fix
type: project
---

## Current state (end of 2026-03-22 session)

**Test262**: 14,720 pass / 48,102 total, 4,443 CE (from earlier run — needs rerun after refactoring)
**Equivalence tests**: 1,055/1,097 (4 regressions from property-access extraction)

**Git**: main branch, pushed to origin.

## Session accomplishments

### Refactoring (#688) — expressions.ts split into 8 modules
- shared.ts (173 lines) — registration pattern for compileExpression
- array-methods.ts (3,247) — all array prototype methods
- string-ops.ts (1,494) — string compilation + native string methods
- binary-ops.ts (1,617) — binary expression compilation
- closures.ts (1,621) — arrow functions, captures, funcref
- typeof-delete.ts (773) — typeof, delete, instanceof, regexp
- object-ops.ts (1,374) — Object.defineProperty, keys/values, hasOwnProperty
- literals.ts (1,293) — object/array/tuple/symbol literals
- property-access.ts (1,636) — property/element access, null guards

**expressions.ts: 27,190 → ~14,150 lines (48% reduction)**

### Issues filed
- #740 — Remove 2.1MB lib copies (read from typescript package)
- #741 — Split index.ts (13,282 lines)
- #742 — Extract calls.ts (retry with table-driven dispatch)

### Key learnings
- esbuild silently treats undefined imports as no-ops — always verify call sites
- Circular deps: use shared.ts registration pattern
- Always clean worktrees BEFORE running vitest (they intercept module resolution)
- Always `cd /workspace` after worktree removal (shell CWD breaks)
- Never do parallel extractions on the same file

## 4 regressions to fix
Array element prefix/postfix increment: `emitBoundsCheckedArrayGet` duplicate in property-access.ts vs array-methods.ts. The property-access.ts `compileElementAccessBody` may reference a different bounds check path.

## Priority for next session
1. Fix 4 array increment regressions
2. #740 — Remove lib copies (agent completed, needs cherry-pick)
3. #741 — Split index.ts (ensureNativeStringHelpers = 2,559 lines)
4. #742 — Extract calls.ts (~6,000 lines remaining in expressions.ts)
5. Run full test262 with refactored code
