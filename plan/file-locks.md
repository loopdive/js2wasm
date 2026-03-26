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
| src/codegen/expressions.ts | compileIdentifier / TDZ checks | dev-790 | #790 | 2026-03-25 |
| src/codegen/index.ts | scope/binding setup | dev-790 | #790 | 2026-03-25 |
| src/codegen/index.ts | compileFunctionBody / param defaults + TDZ | dev-413 | #413 | 2026-03-26 |
| src/codegen/type-coercion.ts | coerceType / emitGuardedRefCast | dev-792 | #792 | 2026-03-26 |
| src/codegen/property-access.ts | emitNullGuardedStructGet | dev-792 | #792 | 2026-03-26 |
<!--
Example entries:
| src/codegen/expressions.ts | compileCallExpression | dev-1 | #512 | 2026-03-25 |
| src/codegen/type-coercion.ts | coerceType | dev-2 | #315 | 2026-03-25 |
| src/codegen/expressions.ts | compileBinaryExpression | dev-3 | #618 | 2026-03-25 |

Note: same FILE with different FUNCTIONS is OK (Git 3-way merge handles separate hunks).
Same function = conflict, must coordinate.
-->
