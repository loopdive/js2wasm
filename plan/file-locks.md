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
| src/codegen/index.ts | emitStructFieldGetters | dev-opaque | opaque-fix | 2026-03-27 |
| src/runtime.ts | _safeGet/_safeSet/sidecar | dev-opaque | opaque-fix | 2026-03-27 |
| src/codegen/index.ts | fixupStructNewResultCoercion | dev-d | struct.new | 2026-03-26 |
| src/codegen/stack-balance.ts | fixCallArgTypesInBody | dev-d | struct.new | 2026-03-26 |
| src/codegen/statements.ts | compileTryStatement | dev-a | #798a | 2026-03-26 |
| src/emit/binary.ts | catch_all encoding | dev-a | #798a | 2026-03-26 |
| src/ir/types.ts | catch_all instruction | dev-a | #798a | 2026-03-26 |
| src/codegen/statements.ts | compileThrowStatement | dev-4 | #798c | 2026-03-26 |
| src/codegen/index.ts | FunctionContext (catchRethrowStack) | dev-4 | #798c | 2026-03-26 |
| src/codegen/typeof-delete.ts | compileTypeofExpression, compileTypeofComparison | dev-8 | #800 | 2026-03-26 |
| src/codegen/expressions.ts | compileIdentifier, emitLocalTdzCheck | dev-tdz | #800 | 2026-03-26 |
| src/codegen/statements.ts | emitTdzCheck (lines 50-94) | dev-tdz | #800 | 2026-03-26 |
| src/codegen/expressions.ts | compileNewExpression (Test262Error) | dev-812 | #812 | 2026-03-26 |
| src/codegen/expressions.ts | RangeError validation (toFixed, repeat, Array ctor) | dev-733 | #733 | 2026-03-26 |
| src/codegen/object-ops.ts | compileObjectDefineProperty, Object.defineProperties | dev-797c | #797c | 2026-03-27 |
| src/codegen/expressions.ts | Object.defineProperties handler (lines 10060-10073) | dev-797c | #797c | 2026-03-27 |
| src/runtime.ts | __defineProperties host import | dev-797c | #797c | 2026-03-27 |
| src/codegen/index.ts | KNOWN_CONSTRUCTORS | dev-812, dev-814 | #812, #814 | 2026-03-26 |
| src/runtime.ts | builtinCtors | dev-814 | #814 | 2026-03-26 |

<!--
Example entries:
| src/codegen/expressions.ts | compileCallExpression | dev-1 | #512 | 2026-03-25 |
| src/codegen/type-coercion.ts | coerceType | dev-2 | #315 | 2026-03-25 |
| src/codegen/expressions.ts | compileBinaryExpression | dev-3 | #618 | 2026-03-25 |

Note: same FILE with different FUNCTIONS is OK (Git 3-way merge handles separate hunks).
Same function = conflict, must coordinate.
-->
