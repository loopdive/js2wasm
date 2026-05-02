---
id: 985
title: "Follow-up to #931: source-anchored locations for compiler catch paths"
status: done
created: 2026-04-07
updated: 2026-04-14
completed: 2026-04-14
priority: medium
feasibility: medium
reasoning_effort: medium
goal: performance
depends_on: [931]
merged: 2026-04-06
---
# #985 -- Follow-up to #931: source-anchored locations for compiler catch paths

## Problem

#931 improved line-number reporting inside codegen, but broad compiler-level
catch paths still collapsed unexpected failures to `0:0` or `1:0` with no
useful source context.

The remaining blind spots sat in:

- `compileSource()`
- `compileMultiSource()`
- `compileFilesSource()`
- `compileToObjectSource()`

These paths wrap top-level codegen exceptions, binary/object emit failures, and
warning-only WAT/optimizer failures. Even without a precise AST node, the
compiler still knows the active `SourceFile`, so `0:0` was avoidable.

## Root cause

1. `compiler.ts` emitted fallback diagnostics directly with `line: 0, column: 0`
2. `generateModule()` / `generateMultiModule()` could still throw past the
   codegen context before `ctx.lastKnownNode` was converted into a diagnostic
3. The infrastructure from #931 (`reportErrorNoNode`, `ctx.lastKnownNode`) was
   present but not applied in these outer catch paths

## Implemented

1. Wrapped `generateModule()` and `generateMultiModule()` in internal catch
   blocks and route unexpected exceptions through `reportErrorNoNode()`
2. Added source-anchored compiler fallback diagnostics in `src/compiler.ts`
   so codegen/emit/warning catch paths point at the first real statement of the
   active source file instead of `0:0`
3. Added regression tests that mock:
   - codegen failure in `compile()`
   - binary emit failure in `compile()`
   - object emit failure in `compileToObject()`

## Result

The remaining compiler fallback paths now produce real source locations instead
of `0:0`, and unexpected codegen exceptions can reuse `ctx.lastKnownNode` when
they happen inside the main codegen pipeline.

Verified with:

- `pnpm run typecheck`
- `pnpm test tests/error-reporting.test.ts tests/error-reporting-catchpaths.test.ts`
