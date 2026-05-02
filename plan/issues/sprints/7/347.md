---
id: 347
title: "- Function/class .name property completion"
status: done
created: 2026-03-13
updated: 2026-04-14
completed: 2026-04-14
priority: high
feasibility: easy
goal: npm-library-support
test262_skip: 404
test262_categories:
  - spread across 15 categories
files:
  src/codegen/expressions.ts:
    new: []
    breaking:
      - "compileFunctionExpression: add .name to all function forms"
  src/codegen/index.ts:
    new: []
    breaking:
      - "emitFunction: store name in function struct"
---
# #347 -- Function/class .name property completion

## Status: open

404 tests check the .name property on functions and classes. Already partially implemented in #147. Needs completion for all function forms (arrow, method, getter/setter, class).

## Details

Function.name is already supported for basic function declarations and expressions (#147). Remaining cases:

1. **Arrow functions**: `var f = () => {}; f.name === "f"`
2. **Method shorthand**: `var obj = { foo() {} }; obj.foo.name === "foo"`
3. **Getter/setter**: `Object.getOwnPropertyDescriptor(obj, "x").get.name === "get x"`
4. **Class names**: `class Foo {}; Foo.name === "Foo"`
5. **Default export**: `export default function() {}` has name `"default"`
6. **Computed property**: name is the computed string value
7. **Assignment inference**: `var f = function() {}; f.name === "f"`

The key insight is that function name inference happens at the assignment/property definition site, not at the function creation site.

## Complexity: S

## Acceptance criteria
- [ ] Arrow functions have correct .name
- [ ] Method shorthand has correct .name
- [ ] Getter/setter have "get x"/"set x" names
- [ ] Class declarations have correct .name
- [ ] 404 previously skipped tests are now attempted
