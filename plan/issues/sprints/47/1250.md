---
id: 1250
title: "logical assignment operators: ||=, &&=, ??= (ES2021)"
status: done
created: 2026-05-02
completed: 2026-05-02
updated: 2026-05-02
priority: medium
feasibility: easy
reasoning_effort: low
task_type: feature
area: codegen
language_feature: operators, logical-assignment
goal: npm-library-support
es_edition: ES2021
related: [1244]
---

## Investigation finding (2026-05-02, dev-1245)

**The operators are already implemented.** Smoke-testing on `origin/main`
shows all three operators (`||=`, `&&=`, `??=`) compile and run correctly
for identifier, property-access, and element-access targets:

```
prop ??= externref-null:    OK (5)
identifier ??= null:        OK (7)
prop ??= 0 (keep):          OK (0 — 0 is not nullish, spec-correct)
prop ||= 0 (reassign):      OK (11)
prop &&= 1 (reassign):      OK (13)
elem ??= null:              OK (42)
short-circuit ??=:          OK (RHS not evaluated)
short-circuit ||=:          OK
short-circuit &&=:          OK
number-typed ??= short-cir: OK (i32/f64 can never be nullish)
```

The implementation is in `src/codegen/expressions/assignment.ts`:
- `emitLogicalAssignmentPattern` (line 3183) — shared if/else codegen for
  the three operators with proper short-circuit semantics.
- Callers wire it from identifier (line 3039), property-access (lines 2817,
  2858, 2938), and element-access (lines 3096, 3156) targets.

The issue title's claim "cause a compile error today" was stale. PR closes
the issue by adding regression tests that lock in the working behavior.

### Edge case (out of scope — separate issue)

The Hono-style `obj[runtimeKey] ??= newValue` pattern, where `obj` is a
TypeScript index signature `{[key: string]: T}` rather than a registered
struct or vec, returns NaN. This is a property of the index-signature
codegen path (the `??=` operator dispatches correctly; the underlying
indexed-set on a dictionary is what fails). Filing as a follow-up
because it's well outside the ES2021 logical-assignment-operators feature
scope.


# #1250 — Logical assignment operators: `||=`, `&&=`, `??=`

## Problem

The logical assignment operators (`||=`, `&&=`, `??=`) introduced in ES2021 cause a compile
error today. Hono's trie-router uses `??=` in route registration:

```ts
this.#children[method] ??= new Node();
```

Prettier, lodash, and other npm libraries also use these patterns.

## Expected lowering

These are syntactic sugar — each should desugar to the short-circuit form:

| Operator | Desugars to |
|----------|-------------|
| `a \|\|= b` | `a \|\| (a = b)` |
| `a &&= b` | `a && (a = b)` |
| `a ??= b` | `a ?? (a = b)` |

The AST node is `AssignmentExpression` with operator `"||="`, `"&&="`, or `"??="`. The
target can be a simple identifier, property access, or element access.

## Implementation

In `src/codegen/expressions.ts` `compileAssignmentExpression`, handle the three new operator
strings alongside the existing `+=`, `-=`, etc. cases. For each:

1. Evaluate the LHS once (store in a temp if it's not a simple local)
2. Emit the short-circuit condition (`||`, `&&`, or `?? `)
3. Inside the true branch, emit the assignment and return the assigned value
4. Return the existing LHS value in the false branch

## Acceptance criteria

1. `a ||= b`, `a &&= b`, `a ??= b` all compile and produce correct results.
2. Property access targets (`obj.field ??= value`) work correctly.
3. `tests/issue-1250.test.ts` covers all three operators on local and property targets.
4. No regression in `tests/equivalence/` operator tests.

## Related

- #1244 — Hono stress test; Tier 2 uses `??=`
- #1249 — class private fields (also Tier 2 blockers)
