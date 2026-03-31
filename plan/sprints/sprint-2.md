# Sprint 2

**Date**: 2026-03-11 (afternoon)
**Goal**: Runtime failure reduction — 167 failures and ~1,200 compile errors
**Baseline**: 1,509 pass

## Issues
- #175, #177, #180, #181, #183-#186 — Type coercion and operator edge cases
- #187, #191 — Prototype skip filter refinement, assert.compareArray
- #193, #195, #196, #197 — Unary plus, negative zero, var re-declaration, function hoisting
- #200, #203, #205 — Built-in method compile errors, LEB128 i64 truncation
- #207, #208 — Unicode escape resolution, computed property names, boolean relational ops
- #209, #210, #213 — Do-while continue, for-of destructuring
- #211 — Void function comparison to undefined, Function.length property
- #212 — Cache tagged template objects per call site
- #214 — Widen empty object literals, string relational ops, unary plus coercion
- #215, #216 — Modulus edge cases
- #217 — Labeled block break
- #218, #219 — Remove Boolean() skip filter
- #220 — ClassDeclaration in all statement positions
- #221 — .call() and comma-operator indirect call patterns
- #222 — Hoist var declarations from destructuring patterns
- #223, #224 — Computed property names in classes, member increment/decrement

## Results
**Final numbers**: ~1,509+ pass (merged same day as Sprint 1)
**Delta**: Primarily reduced runtime failures and compile errors
**Equivalence tests**: 86 → 170

## Notes
- 12 branches, 18 issues planned
- Key wins: destructuring hoisting (~1,200 CE reduction), string comparison, .call(), member increment/decrement
- Sprint 2 planning commit at 2026-03-11 15:33
