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
| src/codegen/index.ts | compileClass* | dev-agent | #820 | 2026-03-28 |
| src/codegen/expressions.ts | compilePropertyAccess | dev-agent | #820 | 2026-03-28 |
| src/runtime.ts | _toPrimitive / buildImports | dev-agent-866 | #866 | 2026-03-28 |
| src/codegen/statements.ts | emitDefaultParamInit | dev-agent-866 | #866 | 2026-03-28 |
| src/codegen/type-coercion.ts | pushParamSentinel/pushDefaultValue | dev | #869 | 2026-03-29 |
| src/codegen/index.ts | OptionalParamInfo, top-level default init | dev | #869 | 2026-03-29 |
| src/codegen/statements.ts | emitDefaultParamInit | dev | #869 | 2026-03-29 |
| src/codegen/expressions.ts | call sites (pushParamSentinel) | dev | #869 | 2026-03-29 |
| src/codegen/index.ts | fixupStructNewArgCounts | dev-1 | #822 | 2026-03-29 |
| src/codegen/index.ts | collectClassDeclaration (async private gen) | dev-2 | #828 | 2026-03-29 |
| src/codegen/stack-balance.ts | fixBranchType | dev-agent | #826 | 2026-04-03 |
| src/codegen/type-coercion.ts | externrefToRef no-fctx path | dev-agent | #826 | 2026-04-03 |
| src/codegen/string-ops.ts | compileTaggedTemplateExpression | dev-836 | #836 | 2026-04-03 |
| src/runtime.ts | __defineProperty_value, __defineProperties | dev-856 | #856 | 2026-04-03 |

<!--
Example entries:
| src/codegen/expressions.ts | compileCallExpression | dev-1 | #512 | 2026-03-25 |
| src/codegen/type-coercion.ts | coerceType | dev-2 | #315 | 2026-03-25 |
| src/codegen/expressions.ts | compileBinaryExpression | dev-3 | #618 | 2026-03-25 |

Note: same FILE with different FUNCTIONS is OK (Git 3-way merge handles separate hunks).
Same function = conflict, must coordinate.
-->
