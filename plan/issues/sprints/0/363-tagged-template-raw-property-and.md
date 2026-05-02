---
id: 363
title: "- Tagged template .raw property and identity"
status: done
created: 2026-03-13
updated: 2026-04-14
completed: 2026-04-14
priority: low
feasibility: medium
goal: property-model
test262_skip: 24
files:
  src/codegen/expressions.ts:
    new:
      - "tagged template .raw property support"
    breaking:
      - "compileTaggedTemplate — add .raw property to template strings array"
---
# #363 -- Tagged template .raw property and identity

## Status: done
completed: 2026-03-16

16 tests need `.raw` access on tagged template strings array, 8 need object identity checks on template objects.

## Details

Tagged templates pass a template object with a `.raw` property:
```javascript
function tag(strings) {
  strings[0]; // "Hello\n"
  strings.raw[0]; // "Hello\\n" (unprocessed)
  return strings;
}
tag`Hello\n`;
```

Template object identity (same template literal always gets the same frozen object):
```javascript
function tag(strings) { return strings; }
var a = tag`hello`;
var b = tag`hello`;
a === b; // true (same template object)
```

Implementation:
1. Create a `.raw` array alongside the cooked strings array
2. Raw strings preserve escape sequences as-is
3. Cache template objects by source position for identity guarantees
4. Template objects should be frozen (depends on #359 for full freeze support)

## Complexity: M

## Acceptance criteria
- [ ] `strings.raw[i]` returns unprocessed template strings
- [ ] Template objects have correct `.raw` property
- [ ] Same template literal returns identical object (identity check)
- [ ] 24 previously skipped tests are now attempted

## Implementation Summary

Used WasmGC struct subtyping to create a template vec type `{length, data, raw}` as a subtype of the base vec `{length, data}`. This allows template vecs to pass where base vecs are expected. Added `getOrRegisterTemplateVecType()` in index.ts, extended `compileTaggedTemplateExpression` to build both raw and cooked string arrays, added `.raw` property access via `ref.cast` downcast in `compilePropertyAccess`, and updated `compileElementAccess` to recognize template vec structs.

**Files changed:** `src/codegen/index.ts`, `src/codegen/expressions.ts`, `tests/equivalence/ts-wasm-equivalence.test.ts`
**What worked:** WasmGC struct subtyping for the template vec / base vec relationship. Raw strings use TS AST's `rawText` property.
