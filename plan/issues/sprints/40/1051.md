---
id: 1051
title: "Private static class methods: wrong return value via private-name dispatch"
status: done
created: 2026-04-11
updated: 2026-04-11
completed: 2026-04-28
priority: low
feasibility: medium
reasoning_effort: medium
task_type: bugfix
language_feature: test262-harvest-cluster
goal: test-infrastructure
es_edition: multi
---
sprint: 40

# #1051 — Private static class methods: wrong return value via private-name dispatch

## Problem

Private-name static methods dispatched via the class name (e.g. `C.$(1)`) return the wrong value. The tests define private static methods using identifiers like `$`, `_`, `o` and expect the public wrapper `C.$(n)` to return `n`.

## Evidence from harvest

- **Test count:** 88 tests currently failing with this pattern
- **Top path buckets:**
  - `44 test/language/statements/class/elements/*`
  - `44 test/language/expressions/class/elements/*`
- **Top error messages:**
  - 16× `returned 5 — assert #4 at L102: assert.sameValue(C.$(1), 1); assert.sameValue(C._(1), 1); assert.sameValue(C.o(1), 1)`
- **Sample test files:**
  - `test/language/statements/class/elements/after-same-line-method-rs-static-privatename-identifier-alt.js`
  - `test/language/expressions/class/elements/same-line-gen-rs-static-privatename-identifier-by-classname.js`
  - `test/language/statements/class/elements/after-same-line-static-method-rs-static-privatename-identifier-alt.js`

## ECMAScript spec reference

- [§15.7.14 Runtime Semantics: ClassDefinitionEvaluation](https://tc39.es/ecma262/#sec-runtime-semantics-classdefinitionevaluation) — step 22: install static private methods on the constructor
- [§7.3.31 PrivateGet](https://tc39.es/ecma262/#sec-privateget) — retrieves value from private name binding; for methods, returns the method closure


## Root cause hypothesis

Private static method dispatch resolves to the wrong slot or reads from an instance-level private table instead of the class constructor's own private-slot table, so the returned value comes from an unrelated slot.

## Fix

Bind private static methods to the constructor object (not the prototype instances), and ensure `C.$(n)` calls the correct closure with `this === C`. Audit the private-name lookup to separate static vs instance slot tables.

## Expected impact

~88 FAIL.

## Key files

- src/codegen/expressions.ts (private static method emission and dispatch)

## Source

Filed by `harvester-post-sprint-40-merge` 2026-04-11 against the post-merge Sprint 40 main baseline (`benchmarks/results/test262-current.jsonl`, 43,164 records).

## Root cause (2026-04-11)

Not a method-dispatch bug — a **static-private-field assignment** bug. The
failing tests look like:

```js
class C {
  static #a;
  static $(value) { C.#a = value; return C.#a; }
}
assert.sameValue(C.$(1), 1);  // actually got null → returned 5 (assert index)
```

`compilePropertyAssignment` at `src/codegen/expressions/assignment.ts:1453`
computed the static-props key as `` `${clsName}_${target.name.text}` `` —
using the raw `target.name.text` without the `"__priv_"` transform. For a
PrivateIdentifier `text` is `"#a"`, so the lookup key was `"C_#a"` while the
global is registered as `"C___priv_a"`. `staticProps.get` returned undefined,
the static-write branch fell through, and the assignment silently went
nowhere. Subsequent `C.#a` reads returned the field's `ref.null` / zero
initializer.

Both the read path (`property-access.ts:807`) and the compound-assign path
(`assignment.ts:3607`) already applied the `__priv_` transform correctly —
only simple assignment was broken.

## Fix

`src/codegen/expressions/assignment.ts:1453` — apply the same
`ts.isPrivateIdentifier(target.name) ? "__priv_" + target.name.text.slice(1) : target.name.text`
transform when building the staticProps lookup key.

## Test Results (after fix)

Scoped tests in `tests/issue-1051.test.ts`: 3/3 passing.

Test262 cluster sweep (tests matching `static-privatename-identifier`):
- `language/statements/class/elements`: 84/120 pass (was 0 of the harvested 44)
- `language/expressions/class/elements`: 85/121 pass (was 0 of the harvested 44)

Both harvester-cited samples (`after-same-line-static-method-...` and
`same-line-method-...`) now return 1. Remaining FAILs in the cluster are
tests that exercise other class semantics (hasOwnProperty on prototype,
verifyProperty with flags) — those are #1047 territory, not #1051.

Scoped class equivalence tests pass (29/29): private-class-members,
private-fields-edge, private-fields-extended, computed-property-class,
nested-class-declarations.
