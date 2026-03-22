---
name: feedback_refactoring_failures
description: When tests fail after refactoring, check for missing imports first — don't speculate about other causes
type: feedback
---

When tests fail after extracting code to a new module, the cause is almost always a **missing import** for a moved function. esbuild silently treats undefined functions as no-ops.

**Don't:** speculate about circular deps, timing, flaky tests, or pre-existing issues.

**Do:** immediately check if every call site of a moved function has a matching import. Run: `grep 'functionName' src/codegen/expressions.ts | grep -v import` — if there are calls without imports, that's the bug.

This happened 4 times in one session:
1. `compileBinaryExpression` — missing import, all binary ops returned 0
2. `resolveArrayInfo` — missing import, array length assignment broken
3. `promoteAccessorCapturesToGlobals` — missing import, getter/setter broken
4. `emitBoundsGuardedArraySet` — missing import, array increment broken
