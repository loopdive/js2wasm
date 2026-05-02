---
id: 384
title: "- replaceAll and other missing string methods"
status: done
created: 2026-03-13
updated: 2026-04-14
completed: 2026-04-14
priority: low
feasibility: easy
goal: contributor-readiness
test262_ce: 5
files:
  src/codegen/index.ts:
    new: []
    breaking:
      - "compiler options — update target/lib to support newer string methods"
---
# #384 -- replaceAll and other missing string methods

## Status: done
completed: 2026-03-16

5+ tests fail with "Property 'replaceAll' does not exist on type 'string'" because the TypeScript compilation target or lib doesn't include newer string methods.

## Details

```javascript
'hello world'.replaceAll('o', '0'); // 'hell0 w0rld'
```

`String.prototype.replaceAll` was added in ES2021. If the compiler is targeting an older ES version or not including the ES2021 lib, TypeScript won't recognize these methods.

Fix: update the `target` or `lib` in the compiler's TypeScript configuration to include ES2021+ string methods:
- `replaceAll` (ES2021)
- `at` (ES2022)
- Other newer methods as needed

## Complexity: XS

## Acceptance criteria
- [ ] `replaceAll` is recognized on string types
- [ ] Other ES2021+ string methods are available
- [ ] 5+ previously failing compile errors are resolved

## Implementation Summary

Created `src/checker/lib-es2021.ts` with TypeScript type declarations for ES2021+ methods (replaceAll, at, findLast, findLastIndex, Object.hasOwn). Added import in `src/checker/index.ts` and appended to the lib.d.ts composition string. The custom compiler host only served explicitly registered lib files, so simply changing the target wasn't enough — the declarations had to be added manually.

**Files changed:** `src/checker/lib-es2021.ts` (new), `src/checker/index.ts`
**What worked:** Adding a focused lib declaration file following the existing pattern (lib-es5, lib-es2015, etc.).
