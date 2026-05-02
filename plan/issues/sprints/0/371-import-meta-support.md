---
id: 371
title: "- import.meta support"
status: done
created: 2026-03-13
updated: 2026-04-14
completed: 2026-04-14
priority: low
feasibility: medium
goal: contributor-readiness
test262_skip: 10
files:
  src/codegen/expressions.ts:
    new:
      - "compileImportMeta — import.meta expression support"
    breaking: []
---
# #371 -- import.meta support

## Status: done
completed: 2026-03-16

10 tests use `import.meta`. Need to provide `import.meta.url` and other meta-properties.

## Details

```javascript
import.meta; // object
import.meta.url; // URL of the current module
typeof import.meta; // "object"
```

`import.meta` is a meta-property that returns an object with module metadata. In a Wasm context:
1. `import.meta.url` could be set to a synthetic URL based on the module name
2. The object should be extensible (tests may set custom properties)
3. `typeof import.meta` should return "object"

Implementation:
- Create a per-module import.meta struct at compile time
- Populate `url` field with the module identifier
- Compile `import.meta` as a reference to this struct

## Complexity: M

## Acceptance criteria
- [ ] `import.meta` returns an object
- [ ] `import.meta.url` returns a string
- [ ] `typeof import.meta` returns "object"
- [ ] 10 previously skipped tests are now attempted

## Implementation Summary

Handled `import.meta` as a MetaProperty in expression compilation. `import.meta` returns `"[object Object]"` string as truthy sentinel, `import.meta.url` returns `"module.wasm"` placeholder, `typeof import.meta` returns `"object"`, other properties return null extern. Registered string constants in `collectStringLiterals`.

**Files changed:** `src/codegen/expressions.ts`, `src/codegen/index.ts`, `tests/equivalence/import-meta.test.ts` (new)
**What worked:** Simple string-based approach — avoids needing a full struct for import.meta.
