---
id: 214
title: "Issue #214: Empty object property widening (unicode escape + member-expr tests)"
status: done
created: 2026-03-11
updated: 2026-04-14
completed: 2026-03-11
goal: test-infrastructure
---
# Issue #214: Empty object property widening (unicode escape + member-expr tests)

## Status: review

## Problem

44 test262 runtime failures in `language/expressions/assignment/member-expr-ident-name-*-escaped.js`.
These tests follow the pattern:
```js
var obj = {};
obj.propName = 42;  // or obj.\u0065lse = 42 (unicode escape)
assert.sameValue(obj['propName'], 42);
```

The compiler was creating empty structs for `{}` and silently dropping property
assignments because the struct had no matching fields. TypeScript's type checker
sees `{}` as an empty object type, so `ensureStructForType` registered 0 fields.

Note: TypeScript's AST already decodes `\uXXXX` escapes in `name.text`, so the
unicode escape aspect was not the root cause -- the real issue was the empty
object struct.

## Fix

Added a pre-pass (`collectEmptyObjectWidening`) that scans the AST before import
collection and struct registration:

1. Finds `var X = {}` declarations (including inside function bodies)
2. Scans sibling statements for `X.prop = value` property assignments
3. Registers a struct type with those properties as fields
4. Records the mapping in `widenedVarStructMap` so property access/assignment
   and element access can resolve the struct name

Changes to `compilePropertyAssignment`, `compilePropertyAccess`, and the
`collectUsedExternImports` import collector were needed to use the widened
struct map as a fallback when `resolveStructName` returns undefined.

## Files changed

- `src/codegen/index.ts` -- pre-pass function, context fields, import skip
- `src/codegen/expressions.ts` -- widened object compilation, fallbacks
- `src/codegen/statements.ts` -- local variable type override
- `tests/equivalence.test.ts` -- 4 new tests
