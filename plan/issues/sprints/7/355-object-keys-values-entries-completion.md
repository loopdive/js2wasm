---
id: 355
title: "- Object.keys/values/entries completion"
status: done
created: 2026-03-13
updated: 2026-04-14
completed: 2026-04-14
priority: medium
feasibility: easy
goal: platform
test262_skip: 74
test262_categories:
  - spread across 15 categories
files:
  src/codegen/expressions.ts:
    new: []
    breaking:
      - "compileObjectKeys: handle all object types"
---
# #355 -- Object.keys/values/entries completion

## Status: open

74 tests need fuller Object.keys/values/entries support. Partially done in #201. Remaining tests need it to work with all object types, not just known structs.

## Details

Object.keys/values/entries is partially implemented (#201) for statically-known struct types. Remaining gaps:

1. **Dynamic objects**: Objects whose type is not fully known at compile time
2. **Inherited properties**: Should not be included (own properties only)
3. **Non-enumerable properties**: Should be excluded
4. **String-keyed numeric indices**: `{0: "a", 1: "b"}` should return `["0", "1"]`
5. **Order**: Numeric keys first (ascending), then string keys (insertion order)
6. **Primitive arguments**: `Object.keys("abc")` returns `["0", "1", "2"]`

For the easy/quick-win portion, focus on cases where the struct type is known but the existing implementation doesn't handle edge cases.

## Complexity: S

## Acceptance criteria
- [ ] Object.keys works with numeric-keyed objects
- [ ] Object.values works with all struct types
- [ ] Object.entries works with all struct types
- [ ] Key ordering follows spec (numeric then insertion order)
- [ ] 74 previously skipped tests are now attempted
