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

<!-- GENERATED_ISSUE_TABLES_START -->
## Issue Tables

_Generated from issue frontmatter. Update issue `sprint` / `status`, then rerun `node scripts/sync-sprint-issue-tables.mjs`._

### Done

| Issue | Title | Priority | Status |
|---|---|---|---|
| #116 | Issue 116: Unskip implemented features in test262 runner |  | done |
| #117 | Issue 117: String comparison support in test262 harness |  | done |
| #118 | Issue 118: compareArray.js test262 harness include |  | done |
| #119 | Issue 119: assert.throws support in test262 harness |  | done |
| #120 | Issue 120: undefined/void 0 comparison support |  | done |
| #122 | Issue 122: arguments object |  | done |
| #126 | Issue 126: valueOf/toString coercion |  | done |
| #127 | Issue 127: Private class members (#field, #method) |  | done |
| #128 | Issue 128: BigInt type |  | done |
| #131 | String concatenation with variables |  | done |
| #132 | Logical operators returning values (short-circuit) |  | done |
| #133 | typeof runtime comparison |  | done |
| #134 | Switch fallthrough |  | done |
| #135 | Ternary/conditional returning non-boolean values |  | done |
| #136 | Loose equality (== / !=) |  | done |
| #137 | Object literal getter/setter |  | done |
| #175 | Bug: Negative zero not preserved in arithmetic operations |  | done |
| #177 | - Bug: Spread operator in new expressions |  | done |
| #180 | JS var re-declaration: 'Subsequent variable declarations must have the same type' |  | done |
| #181 | Unsupported `new Object()` and `new Function()` constructor calls |  | done |
| #183 | Template literal type coercion wasm errors |  | done |
| #184 | - Function arity mismatch: 'not enough arguments on the stack' |  | done |
| #185 | Unary plus on non-numeric types |  | done |
| #186 | `typeof null` returns wrong value |  | done |
| #187 | String prototype methods: heavy test skipping due to include filters |  | done |
| #191 | `assert` not found: tests using raw `assert()` calls |  | done |
| #193 | Coalesce operator wasm type mismatch |  | done |
| #195 | Prefix/postfix increment/decrement compile errors |  | done |
| #196 | Try/catch/finally: 66 compile errors |  | done |
| #197 | Statement-level `if` compile errors |  | done |
| #200 | JSON.parse/JSON.stringify: 24 compile errors |  | done |
| #203 | LEB128 encoding overflow for large type indices |  | done |
| #205 | String.prototype.indexOf type coercion errors |  | done |
| #206 | For-loop with function declarations: 182 compile errors |  | done |
| #207 | Issue #207: Class statement/expression runtime failures |  | done |
| #208 | Issue #208: Computed property names with complex expressions |  | done |
| #209 | - For-loop continue with string concatenation: any-typed += dispatch |  | done |
| #210 | Issue #210: for-of destructuring with default values |  | done |
| #211 | - Function statement runtime failures |  | done |
| #212 | Issue #212: Object computed property name runtime failures |  | done |
| #213 | - Bug: New expression spread arguments |  | done |
| #214 | Issue #214: Empty object property widening (unicode escape + member-expr tests) |  | done |
| #215 | Issue #215: Unary plus coercion for strings and booleans |  | done |
| #216 | Issue #216: Modulus with special IEEE 754 values |  | done |
| #217 | - While/do-while with string/object loop conditions and labeled block break |  | done |
| #218 | Issue #218: Boolean(x = 0) should return false |  | done |
| #219 | Issue #219: Misc test262 failures |  | done |
| #220 | - ClassDeclaration compile errors in all statement positions |  | done |
| #221 | Issue #221: Unsupported call expression patterns |  | done |
| #222 | Issue #222: Unknown identifier errors from unhoisted var declarations |  | done |
| #223 | Issue #223: Computed property names in class declarations |  | done |
| #224 | Issue #224: Prefix/postfix increment/decrement on member expressions |  | done |

<!-- GENERATED_ISSUE_TABLES_END -->
