# File Locks

Active file/function claims by agents. **Check before editing. Update when starting/finishing work.**

## Protocol

1. **Before starting**: read this file, check for conflicts with your target files/functions
2. **If no conflict**: add your claim, then start work
3. **If conflict**: message the claiming agent to coordinate, or pick different work
4. **On completion**: remove your claim

## Active Locks

| File | Function/Area | Agent | Issue | Since |
|------|--------------|-------|-------|-------|
| src/codegen/index.ts | fixupStructNewResultCoercion | dev-d | struct.new | 2026-03-26 |
| src/codegen/stack-balance.ts | fixCallArgTypesInBody | dev-d | struct.new | 2026-03-26 |
| src/codegen/statements.ts | compileTryStatement, compileThrowStatement | dev-1 | #798b | 2026-03-26 |
| src/codegen/expressions.ts | Object.freeze/seal/preventExtensions | dev-797d | #797d | 2026-03-26 |
| src/codegen/property-access.ts | emitNullGuardedStructGet, emitNullCheckThrow | dev-7 | #800 | 2026-03-26 |
| src/codegen/object-ops.ts | compileObjectFreeze/Seal | dev-797d | #797d | 2026-03-26 |
| src/codegen/typeof-delete.ts | compileTypeofExpression, compileTypeofComparison | dev-8 | #800 | 2026-03-26 |

<!--
Example entries:
| src/codegen/expressions.ts | compileCallExpression | dev-1 | #512 | 2026-03-25 |
| src/codegen/type-coercion.ts | coerceType | dev-2 | #315 | 2026-03-25 |
| src/codegen/expressions.ts | compileBinaryExpression | dev-3 | #618 | 2026-03-25 |

Note: same FILE with different FUNCTIONS is OK (Git 3-way merge handles separate hunks).
Same function = conflict, must coordinate.
-->
