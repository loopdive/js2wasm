# Changelog

## Historical sprint tags

This file records the historical sprint boundary tags created from the sprint history in `plan/sprints/` and the Git history on `main`.

Tagging method:

- Use an explicit sprint-closing commit when one exists, for example `sprint-31 suspend`.
- Otherwise use the closest `main` snapshot that matches the documented sprint boundary and/or the archived `test262` run for that sprint.
- `sprint/32`, `sprint/34`, and `sprint/35` were not tagged because their sprint docs are still planning or incomplete.
- `sprint/33` does not exist in the current sprint history.

## Current test262 status

Latest complete archived full-suite entry: `20260331-215747` from [benchmarks/results/runs/index.json](/Users/thomas/Documents/Arbeit/Startup/Projekte/Mosaic/code/@loopdive/ts2wasm/benchmarks/results/runs/index.json)

- Pass rate: `15,155 / 48,174` = `31.5%`
- Previous full-suite entry: `15,246 / 48,174` = `31.7%`
- Note: [benchmarks/results/test262-report.json](/Users/thomas/Documents/Arbeit/Startup/Projekte/Mosaic/code/@loopdive/ts2wasm/benchmarks/results/test262-report.json) currently points to a missing target, so the pass rate above is sourced from the run index rather than the symlink.

## Sprint history

## Sprint 0 - v0.0.0

- Tags: `sprint/0`, `v0.0.0`
- Date range: 2026-02-27 to 2026-03-10
- Goal: Build the compiler, runtime, playground, and first conformance baseline before structured sprint tracking began.
- Worked on: Turned the initial prototype into a real TypeScript-to-Wasm toolchain: core AOT compilation, CLI and playground, import resolution and stdlib growth, classes/closures/async-await/destructuring, relocatable object emission and multi-memory linking, linear-memory backend work, fast mode, native strings and arrays, gradual typing, npm/package resolution, SIMD and benchmark infrastructure, and the first serious test262 subset runs that reached the 550-pass baseline used by Sprint 1.
- Baseline: project bootstrap / no recorded sprint baseline
- Final result: pre-Sprint-1 baseline established at `550` test262 passes
- test262: `550` pass (100% of compilable tests at that point)

### Issues worked on

- #31 Default number type to i32, promote to f64 only when needed
- #33 Relocatable Wasm Object File (.o) Emission
- #34 Multi-Memory Module Linker with Isolation Validation
- #35 Class inheritance with extends and super
- #36 Static class members
- #37 Getter/Setter Properties on User-Defined Classes
- #38 Implement `instanceof` operator
- #39 Labeled Break and Continue
- #40 String Enums
- #41 typeof as Expression
- #42 Comma operator support
- #43 void Expression
- #44 Source Map Generation
- #45 Error reporting with source locations
- #46 Linear-memory compilation backend
- #47 importedStringConstants support
- #49 Default parameter values
- #50 Nullish and logical assignment operators
- #51 Functional array methods (filter, map, reduce, forEach, find)
- #52 String.split() method
- #53 Numeric separators
- #54 Map and Set collections
- #55 Function expressions
- #56 Tuples
- #57 Class expressions
- #58 Iterators and for...of with custom iterables
- #59 Abstract classes
- #60 RegExp via host imports
- #61 Object.keys / Object.values / Object.entries
- #62 JSON.parse / JSON.stringify via host
- #63 Promise.all / Promise.race
- #64 Generators and yield
- #65 Computed property names
- #67 Closed import objects — replace Proxy with compiler manifest
- #68 DOM containment — scope wasm module access to a subtree
- #69 Safe mode — restrict TypeScript to a secure subset
- #70 Fast mode — optimize for performance with restricted TypeScript
- #71 Fast mode — WasmGC-native strings
- #72 Fast mode — WasmGC-native arrays
- #73 Benchmark — JS vs host-call vs GC-native vs linear-memory performance
- #74 WASM SIMD support for string and array operations
- #75 Slice-based string views for substring/trim/slice
- #76 Rope/cons-string for O(1) concatenation
- #77 Object literals, spread, and structural typing
- #78 Standard library coverage — builtins and static methods
- #79 Gradual typing — boxed `any` with runtime dispatch
- #80 JS file compilation via `.d.ts` types and TS inference
- #81 npm package resolution and tree-shaking
- #83 Test262 conformance subset
- #85 Variadic `Math.min` / `Math.max`
- #87 Math.round negative zero preservation
- #88 Test262 coverage — language/expressions
- #89 Test262 coverage — language/statements
- #90 Test262 coverage — built-ins/Array
- #91 Test262 coverage — built-ins/Number
- #92 Test262 coverage — language/types (coercion)
- #93 Test262 coverage — built-ins/Object
- #94 Test262 coverage — language/function-code
- #95 Test262 coverage — built-ins/isNaN + isFinite
- #96 Test262 coverage — built-ins/JSON
- #97 NaN/undefined/null truthiness in boolean contexts
- #98 Proper ToInt32 modular arithmetic for bitwise operations
- #99 Externref arithmetic, comparison, and control flow
- #100 Mutable closure captures via ref cells
- #101 Test262 — language/statements remaining
- #102 Test262 — language/expressions remaining
- #103 Test262 — built-ins/String prototype methods
- #104 Test262 — language/ top-level categories
- #105 Test262 — built-ins/Map, built-ins/Set, built-ins/Promise
- #106 Test262 — built-ins/Object extended + built-ins/Array constructor
- #107 Fix codegen null-dereference crashes (90 occurrences)
- #109 Tagged template literals

## Sprint 1 - v0.1.0

- Tags: `sprint/1`, `v0.1.0`
- Date range: 2026-03-11 (morning) to 2026-03-11 (morning)
- Goal: First test262 conformance push — language feature coverage
- Worked on: Built the first serious test262 push: harness improvements, BigInt support, private class members, arguments/valueOf/toString behavior, object literal accessors, destructuring, IIFE support, and broad operator/coercion fixes.
- Baseline: 550 pass (100% of compilable tests at the time)
- Final result: 1,509 pass / ~23,000 total
- test262: `550 -> 1,509` pass
- Delta: +959 pass (+174% from 550)

### Issues worked on

- #116 Unskip implemented features in test262 runner
- #117 String comparison support in test262 harness
- #118 compareArray.js test262 harness include
- #119 assert.throws support in test262 harness
- #120 undefined/void 0 comparison support
- #121 Function.prototype.call/apply
- #122 arguments object
- #123 Wrapper object constructors: new Number/String/Boolean (648 tests)
- #124 delete operator via undefined sentinel (232 tests)
- #125 Object.defineProperty / property descriptors (106 tests)
- #126 valueOf/toString coercion
- #127 Private class members (#field, #method)
- #128 BigInt type
- #129 propertyHelper.js test262 harness (341 tests)
- #130 Usage-based shape inference + call/apply inlining
- #131 String concatenation with variables
- #132 Logical operators returning values (short-circuit)
- #133 typeof runtime comparison
- #134 Switch fallthrough
- #135 Ternary/conditional returning non-boolean values
- #136 Loose equality (== / !=)
- #137 Object literal getter/setter
- #138 valueOf/toString coercion on comparison operators
- #139 valueOf/toString coercion on arithmetic operators
- #140 Object computed property names not working at runtime
- #141 Tagged template literal runtime failures
- #142 Assignment destructuring failures
- #143 for-loop edge cases
- #144 new expression with class expressions
- #145 allowJs type flexibility — boolean/string/void as number
- #148 Element access (bracket notation) on struct types
- #150 ClassDeclaration in statement positions
- #151 `this` keyword in class methods for test262
- #152 Setter return value error in allowJs mode
- #154 while/do-while loop condition evaluation
- #155 Logical-and/logical-or short-circuit returns wrong value
- #156 Conditional (ternary) expression evaluation
- #157 void expression returns wrong value
- #158 String concatenation with non-string operands
- #159 Call expression edge cases
- #160 Math method edge cases
- #161 Compound assignment edge cases
- #162 switch statement matching
- #163 return statement edge cases
- #164 variable declaration edge cases
- #165 function statement hoisting and edge cases
- #166 `in` operator runtime failures
- #167 typeof edge cases
- #168 equality operators with null/undefined
- #169 Arrow function edge cases
- #170 Class expression/declaration edge cases
- #171 Boolean() edge cases
- #172 Array.isArray edge case

## Sprint 2 - v0.2.0

- Tags: `sprint/2`, `v0.2.0`
- Date range: 2026-03-11 (afternoon) to 2026-03-11 (afternoon)
- Goal: Runtime failure reduction — 167 failures and ~1,200 compile errors
- Worked on: Focused on runtime failure reduction: type coercion edge cases, built-in method compile errors, computed/class property names, `.call()` support, tagged template caching, for-of destructuring, and member increment/decrement.
- Baseline: 1,509 pass
- Final result: ~1,509+ pass (merged same day as Sprint 1)
- test262: incremental, no isolated archived run
- Delta: Primarily reduced runtime failures and compile errors

### Issues worked on

- #175 Bug: Negative zero not preserved in arithmetic operations
- #177 - Bug: Spread operator in new expressions
- #180 JS var re-declaration: "Subsequent variable declarations must have the same type"
- #181 Unsupported `new Object()` and `new Function()` constructor calls
- #183 Template literal type coercion wasm errors
- #184 - Function arity mismatch: "not enough arguments on the stack"
- #185 Unary plus on non-numeric types
- #186 `typeof null` returns wrong value
- #187 String prototype methods: heavy test skipping due to include filters
- #191 `assert` not found: tests using raw `assert()` calls
- #193 Coalesce operator wasm type mismatch
- #195 Prefix/postfix increment/decrement compile errors
- #196 Try/catch/finally: 66 compile errors
- #197 Statement-level `if` compile errors
- #200 JSON.parse/JSON.stringify: 24 compile errors
- #203 LEB128 encoding overflow for large type indices
- #205 String.prototype.indexOf type coercion errors
- #207 Class statement/expression runtime failures
- #208 Computed property names with complex expressions
- #209 While/do-while with string/object loop conditions and labeled block break
- #210 for-of destructuring runtime failures
- #211 Function.length and undefined comparison edge cases
- #212 Tagged template object caching
- #213 New expression spread arguments and module-level init collection
- #214 String relational ops and unary plus coercion
- #215 Modulus operator edge cases
- #216 More modulus and numeric coercion edge cases
- #217 While/do-while with string/object loop conditions and labeled block break
- #218 Remove Boolean() skip filter
- #219 Additional Boolean runtime fixes
- #220 ClassDeclaration in all statement positions
- #221 .call() and comma-operator indirect call patterns
- #222 Hoist var declarations from destructuring patterns
- #223 Computed property names in classes
- #224 Member increment/decrement on class properties

## Sprint 3 - v0.3.0

- Tags: `sprint/3`, `v0.3.0`
- Date range: 2026-03-11 (evening) to 2026-03-11 (evening)
- Goal: Zero runtime failures, ~1,500 CE reduction
- Worked on: Consolidated fixes around string comparison, object `valueOf` coercion, BigInt cross-type equality, nested hoisting, `in` operator runtime behavior, object destructuring, and private-field diagnostics.
- Baseline: ~1,509 pass
- Final result: merged same session, incremental improvements
- test262: incremental, merged same session
- Delta: 13 issues marked done

### Issues worked on

- #225 String comparison in equality ops
- #226 valueOf coercion on object literal comparisons
- #227 BigInt comparison/equality with Number and Infinity
- #228 BigInt equality with Number and Infinity
- #231 Remove overly broad typeof skip filter
- #233 Nested function hoisting in loops/switch
- #236 Super/derived-class diagnostic suppression
- #240 More super/derived-class diagnostic suppression
- #244 In operator runtime failures
- #245 String comparison in switch statements
- #246 Missing struct fields in for-of object destructuring
- #247 Null/undefined arithmetic correct results
- #248 Logical op tests around valueOf coercion
- #251 Equivalence test expansion
- #252 Additional equivalence tests
- #253 Remove overly broad loose inequality skip filter
- #254 Private class field assignment diagnostic suppression
- #255 More equivalence coverage
- #256 Unknown function: f -- locally declared functions not found

## Sprint 4 - v0.4.0

- Tags: `sprint/4`, `v0.4.0`
- Date range: 2026-03-11 to 2026-03-12
- Goal: Diagnostic suppression, bracket notation, destructuring, compound assignment
- Worked on: Reduced compile errors with batch diagnostic suppression while extending dynamic property fallback, bracket writes, destructuring scope handling, anonymous struct registration, arrow/default params, complex for-loop heads, and logical/compound assignment lowering.
- Baseline: ~1,509 pass
- Final result: incremental (same multi-day session)
- test262: incremental, multi-day session
- Delta: Major reduction in compile errors from diagnostic suppression

### Issues worked on

- #257 Unsupported call expression -- double/triple nested calls
- #258 Unsupported call expression -- double/triple nested calls
- #259 ClassDeclaration in block scope
- #261 New expression with inline/anonymous class expressions
- #262 Batch diagnostic suppression for Sprint 4
- #263 Dynamic property access fallback
- #264 Bracket notation write path for const keys
- #265 Additional diagnostic suppression
- #266 Scope resolution for multi-variable destructuring
- #267 Suppress yield-outside-generator diagnostics
- #268 Suppress TS2548 iterator protocol diagnostic
- #269 Strict-mode reserved word diagnostic suppression
- #270 Reserved word/strict-mode diagnostic suppression
- #272 Re-lookup funcIdx after arg compilation
- #273 Anonymous class expressions in new expressions
- #275 Comma operator unused diagnostic suppression
- #276 Additional assignability diagnostic suppression
- #277 Type coercion before local.set/local.tee
- #278 Auto-register anonymous struct types
- #279 Arrow function destructuring params and defaults
- #280 Function expression name binding and closure call
- #281 Object literal method names and spread ordering
- #282 Scan top-level statements for string literals
- #283 Compound assignment type coercion
- #284 Nested destructuring and rest elements in for-of
- #285 Complex for-loop initializers
- #286 Logical assignment compile errors -- nullish and short-circuit
- #316 Runtime failure -- array element access out of bounds

## Sprint 5 - v0.5.0

- Tags: `sprint/5`, `v0.5.0`
- Date range: 2026-03-12 to 2026-03-12
- Goal: Deep runtime fixes — coercion, equality, assignment, instanceof
- Worked on: Tightened runtime semantics: Wasm type-mismatch repair, nested class/function positioning, `instanceof`, default parameter initialization for methods/constructors, assignment result semantics, BigInt/string comparison, unary minus and `-0`, and Math intrinsics in pure Wasm.
- Baseline: building on Sprint 4
- Final result: incremental improvements in runtime correctness
- test262: incremental runtime gains
- Delta: 25+ issues resolved in one session

### Issues worked on

- #178 Resolve Wasm validation errors for type mismatches
- #234 ClassDeclaration in nested/expression positions
- #235 Function.name prefers own name over variable name for named expressions
- #238 Named class expressions in new expressions
- #239 Bracket notation field resolution for struct types
- #250 Function declarations inside for-loop bodies
- #260 Preserve non-null ref type in conditional expressions
- #274 Function .name property access
- #289 Bare identifier/assignment initializers in for-in
- #290 instanceof with class hierarchies and expression operands
- #292 number_toString import for any-typed string +=
- #293 Default parameter initialization for class constructors/methods
- #294 Assignment expressions return RHS value
- #295 BigInt vs String comparison
- #296 Strict equality cross-type comparison
- #297 Switch statement fall-through with default in non-last position
- #298 Nested function mutable captures and capture param padding
- #299 Loose equality null == undefined
- #301 Saturating float-to-int truncation
- #302 Math.min/max zero-argument edge cases
- #303 parseInt edge cases
- #304 Unary minus coercion and -0 preservation
- #306 Prefix/postfix inc/dec on member expressions
- #308 bigint-to-string coercion and ambiguous addition fallback
- #315 Re-read local type after func expr update
- #317 Issue 317
- #318 Issue 318
- #319 Issue 319
- #320 Issue 320
- #321 Issue 321
- #322 Issue 322
- #323 Native type annotations — type i32 = number

## Sprint 6 - v0.6.0

- Tags: `sprint/6`, `v0.6.0`
- Date range: 2026-03-13 to 2026-03-13
- Goal: Test262 expansion, generator fixes, test infrastructure, equivalence tests
- Worked on: Expanded the compiler and runner together: more test262 categories, negative-test support, generator and `new.target` fixes, Promise construction, object introspection, type inference from call sites, dead import elimination, and runner profiling.
- Baseline: building on Sprint 5
- Final result: significant test262 category expansion
- test262: `1,952` pass, `2,248` compilable
- Delta: 80+ issues resolved across Sprint 5-6 session

### Issues worked on

- #121 Function.prototype.call/apply
- #138 valueOf/toString coercion on comparison operators
- #139 valueOf/toString coercion on arithmetic operators
- #141 Tagged template literal runtime failures
- #142 Assignment destructuring failures
- #143 for-loop edge cases
- #146 Unknown identifier resolution from scope/hoisting issues
- #147 Function.name property
- #149 Additional call expression patterns
- #165 function statement hoisting and edge cases
- #176 Unicode escape sequences in property names
- #179 Generator yield in module mode
- #182 Arrow function closure type coercion errors
- #188 instanceof compile errors
- #189 new.target meta-property
- #190 Array destructuring assignment patterns
- #194 Logical assignment operators
- #198 Switch statement compile errors and type coercion
- #199 Labeled statement compile errors
- #201 Object.keys/values/entries
- #202 Var hoisting tests
- #227 BigInt comparison/equality with Number and Infinity
- #228 BigInt equality with Number and Infinity
- #229 Global index corruption when late string imports shift globals
- #230 Computed property names with let/var variable keys
- #232 Module-level object literal methods
- #237 i64 boxing/unboxing coercion paths for AnyValue
- #241 yield-as-identifier diagnostics
- #243 Array destructuring assignment and nested patterns
- #249 typeof Math constants and Math.round precision
- #261 New expression with inline/anonymous class expressions
- #267 Suppress yield-outside-generator diagnostics
- #279 Arrow function destructuring params and defaults
- #287 Spread stack corruption and callback destructuring
- #288 try/catch/finally runs finally on exception in catch body
- #291 in operator fallback with variable keys
- #300 Struct ref in template expressions toString coercion
- #305 ref/ref_null type mismatch resolution
- #307 Promise.resolve/reject/new
- #309 Test262 harness expansion
- #310 Remove 16 overly conservative test262 skip filters
- #311 String.prototype category expansion in test262 runner
- #312 Number prototype method categories in test262 runner
- #313 Add new test262 expression categories
- #314 Compile-time profiling in test262 runner
- #318 Issue 318
- #319 Issue 319
- #320 Issue 320

## Sprint 7 - v0.7.0

- Tags: `sprint/7`, `v0.7.0`
- Date range: 2026-03-13 (continued) to 2026-03-13 (continued)
- Goal: Runtime failure patterns — null guards, skip filter cleanup, gap coverage
- Worked on: Continued runtime cleanup with null guards, `_FIXTURE` filtering, property introspection, wrapper constructors, `delete`, `super` calls, global/globalThis handling, accessor edge cases, graceful extern fallbacks, and a large gap-analysis issue wave.
- Baseline: building on Sprint 6
- Final result: ~6,366 pass (first test262 run recorded at end of day)
- test262: later history records first end-of-day `~6,366` pass
- Delta: Major jump from skip filter cleanup and new test categories

### Issues worked on

- #324 Runtime test failures with wrong return values
- #325 Array rest destructuring null deref
- #326 Array destructuring bounds checking
- #327 Object-to-primitive coercion for increment/decrement
- #328 OmittedExpression for array holes/elision
- #330 ClassExpression in assignment positions
- #331 Strict mode eval/arguments diagnostic suppression
- #332 Skip _FIXTURE helper files in test262
- #334 Private class fields/methods and accessor compound assignment
- #335 Track bracket/brace depth in stripThirdArg/stripUndefinedAssert
- #336 for-of object destructuring on non-struct refs
- #337 Null guards to runtime property/element access
- #338 Negative test support in test262 runner
- #341 Property introspection (hasOwnProperty, propertyIsEnumerable)
- #342 Array.prototype.method.call/apply patterns
- #344 Wrapper constructors new Number/String/Boolean
- #347 Function/class .name property completion
- #348 Null/undefined arithmetic coercion
- #349 String() constructor as function
- #352 Delete operator expression
- #355 Object.keys with numeric-string keys
- #357 IIFE and call expression tagged templates
- #358 Issue 358
- #359 Gap coverage issue
- #361 Runtime `in` operator for array index bounds
- #362 Issue 362
- #367 Remove overly broad string concatenation skip filter
- #368 `this` in global scope
- #369 globalThis identifier
- #375 super.method() and super.prop in class methods
- #377 Getter/setter accessor edge cases
- #378 Graceful fallback for inc/dec on unresolvable access
- #379 Tuple/destructuring type errors
- #380 Unknown variable/function in test scope
- #381 Downgrade "never nullish" diagnostic
- #382 Spread argument in super/function calls
- #385 Array method optional args
- #386 Gap coverage issue

## Sprint 8 - v0.8.0

- Tags: `sprint/8`, `v0.8.0`
- Date range: 2026-03-16 to 2026-03-16
- Goal: Property access, element access, class inheritance, skip filter removal
- Worked on: Deepened property and element access support: externref/class/struct element reads and writes, tagged template identity, arrow-function `.call()` behavior, `import.meta`, narrower skip filters, fallback assignment targets, and class inheritance/property initialization fixes.
- Baseline: ~6,366 pass (from 2026-03-18 run, likely lower on 03-16)
- Final result: incremental (no test262 run recorded this day)
- test262: no dedicated full run archived
- Delta: 50+ issues resolved, major element/property access improvements

### Issues worked on

- #153 BigInt cross-type comparison tests
- #173 BigInt comparison support follow-up
- #174 BigInt comparison support follow-up
- #204 Miscellaneous runtime fixes
- #329 Runtime failure pattern
- #331 Strict mode eval/arguments diagnostic suppression
- #337 Null guards to runtime property/element access
- #339 Runtime failure pattern
- #340 Runtime failure pattern
- #343 Runtime failure pattern
- #344 Wrapper constructors new Number/String/Boolean
- #345 Runtime failure pattern
- #346 Issue 346
- #350 Test coverage improvements
- #351 Test coverage improvements
- #353 Test coverage improvements
- #354 Test coverage improvements
- #356 Remove overly broad skip filter
- #357 IIFE and call expression tagged templates
- #358 Issue 358
- #359 Gap coverage issue
- #360 Remove overly broad skip filters (closure-as-value, JSON.stringify)
- #362 Issue 362
- #363 Tagged template .raw property and identity
- #364 .call()/.apply() on arrow functions and module-level closures
- #365 Additional gap coverage
- #366 Additional gap coverage
- #370 Additional gap coverage
- #371 Compile import.meta expressions
- #372 Additional gap coverage
- #373 Remove outdated loop condition skip filters
- #374 Additional gap coverage
- #376 Additional gap coverage
- #383 Downgrade tolerated syntax diagnostics
- #384 ES2021+ string/array method type declarations
- #387 Graceful fallback for unsupported assignment targets
- #388 Element access on externref
- #389 Element access on class instances
- #390 Assignment to non-array types (70 CE)
- #391 Downgrade TS7053 index signature diagnostic
- #392 Graceful fallback for unknown field access on class structs
- #393 Compound assignment on externref element access
- #395 Function references callable via closure wrapping
- #396 Null guards for struct dereference traps
- #397 Additional fix
- #398 Inherit parent field initializers and accessors
- #399 Additional fix
- #400 Additional fix
- #401 Additional fix
- #402 Additional fix
- #403 Additional fix
- #404 Additional fix
- #405 Additional fix
- #406 Additional fix
- #407 Additional fix

## Sprint 9 - v0.9.0

- Tags: `sprint/9`, `v0.9.0`
- Date range: 2026-03-17 to 2026-03-17
- Goal: Async/await, for-in, try-catch, class features, prototype chain
- Worked on: Large compiler wave across async/await, for-in, try/catch/finally, class fields/methods, operator semantics, runtime error handling, and the start of React scheduler compilation work.
- Baseline: building on Sprint 8
- Final result: no test262 run recorded for this date
- test262: no dedicated full run archived
- Delta: 39 issues touched

### Issues worked on

- #408 Async/await compilation improvement
- #409 Async/await compilation improvement
- #410 Async/await compilation improvement
- #411 Async/await compilation improvement
- #412 Async/await compilation improvement
- #413 For-in loop enhancement
- #414 For-in loop enhancement
- #415 For-in loop enhancement
- #416 For-in loop enhancement
- #417 Try/catch/finally edge case
- #418 Try/catch/finally edge case
- #419 Try/catch/finally edge case
- #420 Try/catch/finally edge case
- #421 Class method/field fix
- #422 Class method/field fix
- #423 Class method/field fix
- #425 Various operator and expression fix
- #427 Various operator and expression fix
- #428 Various operator and expression fix
- #429 Various operator and expression fix
- #430 Various operator and expression fix
- #431 Various operator and expression fix
- #432 Various operator and expression fix
- #433 Various operator and expression fix
- #434 Various operator and expression fix
- #435 Various operator and expression fix
- #436 Various operator and expression fix
- #438 Additional fix
- #441 Additional fix
- #444 Additional runtime improvement
- #445 Additional runtime improvement
- #446 Additional runtime improvement
- #447 Additional runtime improvement
- #448 Additional runtime improvement
- #455 Compile React to Wasm
- #458 Additional issue
- #459 Additional issue
- #460 Additional issue
- #461 Additional issue

## Sprint 10 - v0.10.0

- Tags: `sprint/10`, `v0.10.0`
- Date range: 2026-03-18 (morning) to 2026-03-18 (morning)
- Goal: React compilation milestones, expression parser, playground improvements
- Worked on: Landed major real-world compilation milestones: React scheduler/fiber/hooks/custom renderer work, expression-parser demos, Symbol/WeakMap support, interactive conformance report work, and the first recorded large-scale test262 baseline.
- Baseline: ~6,366 pass (test262 run at 21:35 UTC)
- Final result: 6,366 pass / 23,021 total (first recorded run)
- test262: `6,366 / 23,021`
- Delta: baseline established

### Issues worked on

- #437 Continued fix from previous session
- #439 Generator .return()/.throw() methods and diagnostic downgrade
- #440 Handle dynamic import() expressions gracefully
- #449 Add ref.as_non_null before call_ref
- #450 Benchmark/maths milestone
- #451 Lodash utilities compile to Wasm
- #452 Expression parser / TypeScript compiler pattern tests
- #453 Three.js math and benchmark suite
- #454 pako zlib kernels compile to Wasm
- #455 Compile React to Wasm
- #456 Symbol.iterator/toPrimitive as compile-time constants
- #457 WeakMap/WeakSet support via extern class infrastructure
- #462 Null narrowing in if-statements
- #463 Self-referencing struct types for linked lists/fiber trees
- #464 Array bounds check elimination
- #465 Inline small functions at call sites
- #466 Local reuse via temp-local free list
- #467 Constant folding for binary expressions on numeric literals
- #468 Interactive conformance report with drill-down
- #469 React hooks state machine compiles to Wasm
- #470 f64/i32-to-externref coercion in expression statement context
- #471 Basic Symbol() support
- #472 Additional issue
- #473 Additional issue
- #474 Remove delete operator skip filter
- #475 Additional issue
- #476 Narrow hasOwnProperty.call skip filter
- #477 verifyEqualTo/verifyNotEqualTo propertyHelper stubs
- #478 assert_throws shim correctness
- #479 Additional issue
- #480 Additional issue
- #481 Resolve well-known symbols in element access
- #482 Dispatch [Symbol.toPrimitive] in type coercion
- #483 typeof Symbol() and narrower Symbol skip filter
- #484 Additional issue
- #485 Additional issue
- #486 Additional issue
- #487 Additional issue
- #488 propertyHelper transforms for hasOwnProperty/propertyIsEnumerable

## Sprint 11 - v0.11.0

- Tags: `sprint/11`, `v0.11.0`
- Date range: 2026-03-18 (afternoon/evening) to 2026-03-18 (afternoon/evening)
- Goal: Massive feature push — WASI, native strings, WIT, tail calls, SIMD, type annotations
- Worked on: Added major architecture/features rather than immediate conformance: WASI target support, native strings, WIT generation, tail-call optimization, peephole optimization, SIMD plumbing, native type annotations, TypedArray/ArrayBuffer work, and broader async/generator coverage.
- Baseline: 6,366 pass / 23,021 total
- Final result: 6,366 pass / 23,025 total (second run, minimal change)
- test262: `6,366 / 23,025`
- Delta: +0 pass (feature additions, not test262 focused)

### Issues worked on

- #493 Narrow prototype chain skip filter
- #494 Remove stale skip filters
- #495 Array-like objects with numeric keys
- #496 eval() and new Function() source transform for test262
- #497 Dynamic import() via host-side module loading
- #498 Proxy via type-aware compilation with trap inlining (70 tests)
- #499 with statement via static identifier dispatch
- #500 Remove cross-realm skip filter
- #501 Complete test262 baseline run and pin results
- #502 Quick wins: narrow stale skip filters
- #503 Runner safe-write: don't corrupt report on crash
- #504 Auto-generated README feature coverage + benchmark tables
- #505 Playground: integrate test262 results into test262 browser panel
- #506 Remove redundant conformance-report.html
- #507 Run benchmark suite and generate latest.json
- #508 ts2wasm-jwt: pure Wasm JWT decode + HS256 verify
- #509 Post-fix error analysis: create issues from fresh test262 run
- #510 TS parse errors from test wrapping
- #511 Wasm validation: call/call_ref type mismatch
- #512 RuntimeError: illegal cast
- #513 Fix any-typed equality: object/ref identity broken in __any_strict_eq and externref path
- #514 Generator/async-gen 'options is not defined'
- #515 Wasm validation: uninitialized non-defaultable local + struct.get/set type errors
- #516 struct.new argument count mismatch in class constructors
- #517 Unsupported call expression: class/generator/built-in method calls
- #518 Cannot destructure: not an array type
- #519 Internal error: targetLocal is not defined
- #520 Delete operator: operand must be optional
- #521 Yield keyword not recognized in nested contexts
- #522 Object.keys() requires struct type argument
- #523 Internal compiler errors: undefined property access
- #524 Type '{}' missing Function properties
- #525 RuntimeError: illegal cast
- #526 RuntimeError: dereferencing a null pointer
- #527 Fix test262 script: use tsx instead of node
- #528 Test262 runner -- show progress when starting each batch
- #529 Speed up test262 runner with parallel workers + compilation cache
- #530 Unsupported call expression — remaining CE bucket
- #531 Issue 531
- #532 Wasm validation: call type mismatch -- string addition folded to numeric
- #533 Wasm validation: struct.get on null ref type
- #534 Fix addUnionImports func index shift for parent function bodies
- #535 'delete' cannot be called on identifier in strict mode
- #536 Spread types may only be created from object types
- #537 TypeScript diagnostic suppressions for test262
- #538 PrivateIdentifier + new.target unsupported
- #539 Issue 539
- #540 Array out of bounds guards
- #541 Async flag skip filter blocks many tests
- #542 Negative test skip blocks many tests
- #543 propertyHelper.js + hasOwnProperty.call skip filters
- #544 Remove/narrow stale skip filters
- #545 Hang-risk skip filters
- #546 Remaining skip filters cleanup
- #547 Restore search/filter UI in report.html
- #548 Security: WAT string injection + memory bounds validation
- #549 Security: playground path traversal via symlinks
- #550 Security: XSS via error messages in report.html
- #551 Issue 551
- #552 Issue 552
- #553 Division by zero missing in constant folding
- #554 JSONL concurrent write corruption from parallel workers
- #555 Cache invalidation misses uncommitted source changes
- #556 Performance: O(n^2) struct deduplication in ensureStructForType

## Sprint 12 - v0.12.0

- Tags: `sprint/12`, `v0.12.0`
- Date range: 2026-03-19 (early) to 2026-03-19 (early)
- Goal: Test262 category expansion, continued feature work
- Worked on: Recovered from skip-filter regression by refining category coverage, removing stale skips, expanding test262 harness coverage, and fixing runtime/compiler failure patterns across the newly widened suite.
- Baseline: 5,753 pass / 22,974 total (regression from skip filter changes)
- Final result: 5,797 pass / 22,974 total → 7,139 pass / 22,974 total
- test262: `5,753 -> 7,139 / 22,974`
- Delta: +1,386 pass during the day

### Issues worked on

- #124 delete operator via undefined sentinel (232 tests)
- #125 Object.defineProperty / property descriptors (106 tests)
- #323 Native type annotations — type i32 = number
- #498 Proxy via type-aware compilation with trap inlining (70 tests)
- #557 Performance: repeated instruction tree traversal for index shifting
- #558 Performance: add hash-based function type deduplication
- #559 Addition/subtraction result not coerced to externref before call
- #560 BigInt + Number mixed arithmetic leaves stack dirty
- #561 Math.hypot closure captures ref instead of f64
- #562 Addition/subtraction valueOf coercion + Math special values
- #563 Unsupported call expression
- #564 Worker crashed -- tests lost to worker process crashes
- #565 Wrong return value bucket
- #566 Null pointer dereference (853 FAIL) - local index shift not recursive
- #567 Wasm validation: struct.get on null ref type
- #568 Wasm validation: local.set type mismatch
- #569 Issue 569
- #570 Issue 570
- #571 struct.new argument count mismatch
- #572 Internal compiler errors
- #573 struct.get on null ref in class tests
- #574 Worker crashed -- tests lost to worker process crashes
- #575 Class statement tests all return 0
- #576 TEST_CATEGORIES covers only a subset of previously-tested tests
- #577 Run test262 in a worktree to avoid mid-run code changes
- #578 WASI target: console.log -> fd_write, process.exit -> proc_exit
- #579 Issue 579
- #580 Issue 580
- #581 struct.get on ref.null in Wasm:test function
- #582 local.set type mismatch in class methods
- #583 Stack not empty at fallthrough in Wasm:test
- #584 Null pointer dereference in many tests
- #585 RuntimeError: illegal cast
- #586 Deduplicate array method callbacks
- #587 Deduplicate destructuring code
- #588 Finally block executes multiple times instead of once
- #589 ref.as_non_null on ref.null always traps
- #590 Generator for-of-string missing return depth update
- #591 Split expressions.ts into focused modules
- #592 Consolidate AST collection passes into single visitor
- #593 Minor security/correctness fixes across emit + runtime
- #594 Mark WasmGC struct types as final for V8 devirtualization
- #595 Integer loop inference: emit i32 loop counters
- #596 Eliminate unnecessary ref.cast when type is statically known
- #679 Dual string backend: js-host mode vs standalone mode

## Sprint 13 - v0.13.0

- Tags: `sprint/13`, `v0.13.0`
- Date range: 2026-03-19 (afternoon/evening) to 2026-03-19 (afternoon/evening)
- Goal: Continued test262 improvement, 53 session issues finalized
- Worked on: Finalized the large issue wave from error analysis, documented runtime failure patterns, and expanded the exercised test262 surface from roughly 23k tests to nearly 48k.
- Baseline: 7,139 pass / 22,974 total
- Final result: 9,560 pass / 47,983 total (test set nearly doubled)
- test262: `9,560 / 47,983`
- Delta: +2,421 pass, test suite expanded from ~23K to ~48K tests

### Issues worked on

- #597 Type-specialized arithmetic skips AnyValue for non-addition ops
- #598 Regression tests for typed export signatures
- #599 Decouple native WasmGC strings from fast mode
- #600 Generate WIT interface files from TypeScript types
- #601 Binaryen wasm-opt post-processing pass
- #602 Emit return_call for tail-position calls
- #603 Remove stale skip filters blocking ~2,500 tests
- #604 add asyncHelpers.js shim
- #605 bypass shouldSkip for runtime negative tests
- #606 expand test262 harness with tcoHelper, deepEqual, throwsAsync
- #607 Issue 607
- #608 TypedArray constructor and element access support
- #609 cover all test262 directories in TEST_CATEGORIES
- #610 Issue 610
- #611 Null guards for undefined AST nodes + duplicate escapeWatString
- #612 suppress async iterator diagnostics for for-await-of
- #613 suppress TS2551 property-with-suggestion diagnostic
- #614 ArrayBuffer/DataView/TypedArray in compileNewExpression
- #615 Issue 615
- #616 suppress TS2689 for Iterator/Generator extends
- #617 prevent drop on empty stack for async void calls
- #618 triage umbrella
- #619 handle class element AST nodes in statement/expression compilers
- #620 Issue 620
- #621 graceful fallback for unsupported call expressions
- #622 null guard in destructureParamObject
- #623 increase worker timeout and per-test timeout
- #624 prevent dynamic field addition to class struct types
- #625 detect no-op coerceType to prevent local.set type mismatch
- #626 coerce call/call_ref arguments to match signatures
- #627 handle void RHS in logical operators
- #628 generator yield validation via fctx.isGenerator
- #629 tuple struct destructuring in function/method parameters
- #630 skip Temporal API tests
- #631 prototype chain patterns for class instances
- #632 emit empty string for RegExp flags
- #633 extend shape inference into try/catch/loop/switch blocks
- #634 promote captured locals to globals for object literal accessors
- #642 architecture/platform issue
- #643 atomic report writes for test262 runner
- #644 platform issue
- #645 additional issue
- #646 additional issue
- #647 additional issue
- #648 additional issue
- #649 additional fix
- #650 additional issue
- #651 additional issue

## Sprint 14 - v0.14.0

- Tags: `sprint/14`, `v0.14.0`
- Date range: 2026-03-20 (early) to 2026-03-20 (early)
- Goal: Dual-mode backends, compiler infrastructure
- Worked on: Established the dual-mode backend direction: dual string and RegExp backend work, broader compiler infrastructure changes, and architecture principles later documented for the project.
- Baseline: 9,560 pass / 47,983 total
- Final result: 10,444 pass / 47,773 total
- test262: `10,444 / 47,773`
- Delta: +884 pass

### Issues worked on

- #123 Wrapper object constructors: new Number/String/Boolean (648 tests)
- #333 Additional previously blocked issue
- #490 Additional fix
- #635 architecture/compiler issue
- #636 architecture/compiler issue
- #637 architecture/compiler issue
- #638 Reverse type map / platform issue
- #649 additional fix
- #652 Compile-time ARC
- #653 additional issue
- #654 additional issue
- #655 additional issue
- #656 additional issue
- #657 additional issue
- #658 additional issue
- #659 additional issue
- #660 additional issue
- #661 Temporal / coercion issue bucket
- #662 additional issue
- #663 additional issue
- #664 additional issue
- #665 additional issue
- #668 additional fix
- #669 additional fix
- #670 additional fix
- #679 Dual string backend: js-host mode vs standalone mode
- #682 Dual RegExp backend

## Sprint 15 - v0.15.0

- Tags: `sprint/15`, `v0.15.0`
- Date range: 2026-03-20 (continued) to 2026-03-20 (continued)
- Goal: Type tracking, backlog cleanup, MCP channel server
- Worked on: Pushed on type tracking and tooling: backlog cleanup, MCP channel server integration, more compiler fixes, and broad type-flow work that drove a large pass-count jump across partial/full runs.
- Baseline: 10,444 pass / 47,773 total
- Final result: 10,974 pass → 15,244 pass (by end of day runs)
- test262: `10,974 -> 15,244`
- Delta: +530 to +4,800 (variable due to partial runs)

### Issues worked on

- #672 Additional fix
- #673 Additional fix
- #676 Compiler improvement
- #677 Compiler improvement
- #678 Compiler improvement
- #683 Type tracking issue
- #686 Closure capture types
- #687 Live-streaming report / tooling
- #688 Extract property access / split index.ts umbrella
- #689 additional issue
- #690 additional issue
- #691 additional issue
- #692 additional issue
- #693 Issue 693
- #694 additional issue
- #695 Error classification improvement
- #696 Classify runtime errors
- #697 Ref/ref_null / error classification issue
- #698 property access fallback and setter dispatch coercion
- #699 Compiler pool
- #700 Reuse ts.CompilerHost across compilations (~25% speedup)

## Sprint 16 - v0.16.0

- Tags: `sprint/16`, `v0.16.0`
- Date range: 2026-03-21 to 2026-03-21
- Goal: Error classification, type coercion, equivalence tests
- Worked on: Focused on error classification, ref/ref_null coercion, property-access correctness, equivalence-test expansion, and compile-error reduction while stabilizing the enlarged 48k suite.
- Baseline: ~15,244 pass (from 03-20 evening run)
- Final result: 15,232 pass / 48,097 total
- test262: `15,232 / 48,097`
- Delta: roughly stable (±0 from baseline)

### Issues worked on

- #695 Error classification improvement
- #697 Ref/ref_null / error classification issue
- #702 issue
- #703 issue
- #704 issue
- #705 issue
- #706 issue
- #707 issue
- #708 issue
- #709 issue
- #710 issue
- #711 issue
- #712 issue
- #713 issue
- #714 conformance progress graph with historical trend tracking
- #715 issue
- #716 issue
- #717 issue
- #718 issue
- #719 issue
- #720 missing coercion paths to coercionInstrs
- #721 issue
- #722 issue
- #723 issue
- #724 TypeError for Object.defineProperty on non-configurable properties
- #725 fall back to __extern_get when ref.cast fails in property access

## Sprint 17 - v0.17.0

- Tags: `sprint/17`, `v0.17.0`
- Date range: 2026-03-22 (morning) to 2026-03-22 (morning)
- Goal: expressions.ts refactoring, goal system
- Worked on: Refactored the oversized `expressions.ts`, added goal-system groundwork, and changed pieces of property access, lib handling, and exception flow, but incurred a measurable regression during the refactor.
- Baseline: 15,232 pass / 48,097 total
- Final result: 14,757 pass / 48,097 total → 14,720 pass / 48,102 total
- test262: `15,232 -> 14,720 / 48,102`
- Delta: -512 pass (regression, likely from refactoring)

### Issues worked on

- #726 Multi-struct dispatch for property access on wrong-type GC objects
- #728 Null dereference should throw TypeError instead of trapping
- #739 assertion sub-classification follow-up
- #740 read lib.d.ts from typescript package at runtime
- #741 split index.ts / extract modules
- #742 Extract and refactor compileCallExpression
- #745 Promise/async handling / RegExp flags null behavior
- #746 Inline property tables / hash all codegen files
- #747 Escape analysis / Object.defineProperty host import + transforms
- #748 propertyHelper.js value checks in test262 preamble
- #750 extern.convert_any at call sites for ref→externref mismatch
- #751 monomorphization issue
- #754 issue already fixed by prior work

## Sprint 18 - v0.18.0

- Tags: `sprint/18`, `v0.18.0`
- Date range: 2026-03-22 (afternoon/evening) to 2026-03-22 (afternoon/evening)
- Goal: DAG-based goal system, milestone migration, issue renumbering
- Worked on: Shifted planning/infrastructure from milestones to a DAG-style goal system, renumbered and audited issue streams, and stabilized the branch after the prior refactor regression.
- Baseline: 14,720 pass / 48,102 total
- Final result: 14,720 pass / 48,102 total (stable)
- test262: `14,720 / 48,102`
- Delta: ~0 (infrastructure/planning focused)

### Issues worked on

- #761 Rest/spread destructuring
- #762 Generator .next(value) arguments are silently ignored
- #763 RegExp runtime methods
- #764 Immutable global / Temporal-related issue
- #765 issue
- #766 Symbol.iterator protocol
- #767 Equivalence test coverage
- #768 renumbered session issue
- #769 renumbered session issue
- #770 verifyProperty transform
- #771 externref-backed arguments object to preserve param types
- #772 renumbered session issue
- #773 Monomorphize functions
- #776 Yield in expression position leaves value on stack
- #777 fixupModuleGlobalIndices / immutable global CEs

## Sprint 19 - v0.19.0

- Tags: `sprint/19`, `v0.19.0`
- Date range: 2026-03-23 to 2026-03-23
- Goal: Equivalence tests, RegExp, skip filter work
- Worked on: Worked on equivalence coverage for RegExp/Promise/Proxy/WeakMap, skip-filter cleanup, struct/call coercion fixes, and failure-pattern analysis; the sprint dipped first and then recovered strongly.
- Baseline: 14,720 pass / 48,102 total
- Final result: 14,120 pass / 48,102 total → 15,997 pass / 49,642 total
- test262: `14,120 -> 15,997 / 49,642`
- Delta: Variable — initial regression then recovery to +1,277

### Issues worked on

- #767 Equivalence test coverage
- #774 Additional fix / already-fixed cleanup

## Sprint 20 - v0.20.0

- Tags: `sprint/20`, `v0.20.0`
- Date range: 2026-03-24 to 2026-03-24
- Goal: Light maintenance day
- Worked on: Mostly maintenance and targeted repair work between larger sessions, with very low commit volume and no archived full-suite run.
- Baseline: 15,997 pass / 49,642 total
- Final result: no test262 run recorded
- test262: no archived full run

### Issues worked on

- No specific issues were recorded for this sprint.

## Sprint 21 - v0.21.0

- Tags: `sprint/21`, `v0.21.0`
- Date range: 2026-03-25 to 2026-03-25
- Goal: Mutable closure captures, assertion failures, type errors
- Worked on: Addressed mutable closure captures, assertion-failure patterns, TypeError/null-trap behavior, early error detection, regex-based assert routing, and several compiler error-model fixes.
- Baseline: ~15,997 pass / 49,642 total
- Final result: 15,410 pass / 49,663 total
- test262: `15,410 / 49,663`
- Delta: -587 from peak (expanded test coverage exposing new failures)

### Issues worked on

- #729 generator return values dropped
- #730 TypeError for destructuring null/undefined and new on arrows
- #731 function/class .name property infrastructure
- #732 hasOwnProperty/propertyIsEnumerable correctness
- #734 Array method correctness edge cases
- #738 instanceof to host for unresolvable constructors
- #771 externref-backed arguments object to preserve param types
- #775 null dereferences throw catchable TypeError instead of trapping
- #779 Wrong values / boxed captures written in outer scope
- #780 null guards to throw TypeError instead of trapping
- #781 __async_iterator for for-await-of
- #782 detect JS undefined in destructuring defaults
- #783 throw TypeError when destructuring null/undefined
- #784 early error checks for rest elements, await/yield identifiers, strict reserved words
- #785 null guards for for-of array/string struct.get
- #786 Multi-assertion failures / boxed capture propagation / wrong AnyValue→f64 unboxing
- #787 NaN sentinel for f64 default parameter checks
- #788 modularize src/ into focused subfolder structure

## Sprint 22 - v0.22.0

- Tags: `sprint/22`, `v0.22.0`
- Date range: 2026-03-26 (morning) to 2026-03-26 (morning)
- Goal: Compile-away principle, new issues, memory files
- Worked on: Established the “compile away, don’t emulate” principle while landing null-guard fixes, TDZ checks, `verifyProperty` handling, ref.cast safety, iterator protocol work, memory/process notes, and a new batch of issue triage.
- Baseline: 15,410 pass / 49,663 total
- Final result: 15,579 pass / 49,833 total
- test262: `15,579 / 49,833`
- Delta: +169 pass

### Issues worked on

- #494 Remove stale skip filters
- #766 Symbol.iterator protocol
- #770 verifyProperty transform
- #778 Illegal cast failures
- #789 Null guard only throws TypeError for genuinely null refs
- #790 TDZ checks in closures and for-loop let/const
- #791 Detect SyntaxErrors that ES spec requires but TS parser accepts
- #792 Export exception tag and multi-struct dispatch for emitGuardedRefCast
- #793 class/elements compilation hang investigation
- #794 nested binding patterns with defaults in destructuring
- #795 externref unbox/string-concat coercion for boxed captures
- #796 destructuring default value checks in param destructuring
- #797 Property descriptor work
- #798 foreign JS exceptions / rethrow instruction
- #799 prototype chain walk for property access
- #800 compile-away typeof / null guards / TDZ analysis
- #801 tuple literals in destructuring defaults
- #811 issue
- #812 Test262Error extern class
- #813 private member name collision
- #815 Regression from patch-rescue commits

## Sprint 23 - v0.23.0

- Tags: `sprint/23`, `v0.23.0`
- Date range: 2026-03-26 (afternoon/evening) to 2026-03-26 (afternoon/evening)
- Goal: Push toward 20K pass, team protocol improvements
- Worked on: Continued the same fix wave with more honest measurement discipline: cache-clearing, repeated full-suite verification, and team/protocol updates that corrected previously inflated counts.
- Baseline: 15,579 pass / 49,833 total
- Final result: 15,362 pass / 49,834 total (full run)
- test262: `15,362 / 49,834`
- Delta: -217 pass (honest measurement after cache clear)

### Issues worked on

- #789 Null guard only throws TypeError for genuinely null refs
- #790 TDZ checks in closures and for-loop let/const
- #791 Detect SyntaxErrors that ES spec requires but TS parser accepts
- #792 Export exception tag and multi-struct dispatch for emitGuardedRefCast
- #793 class/elements compilation hang investigation
- #794 nested binding patterns with defaults in destructuring
- #795 externref unbox/string-concat coercion for boxed captures
- #796 destructuring default value checks in param destructuring
- #797 Property descriptor work
- #798 foreign JS exceptions / rethrow instruction
- #799 prototype chain walk for property access
- #800 compile-away typeof / null guards / TDZ analysis
- #801 tuple literals in destructuring defaults
- #802 issue
- #803 issue
- #804 issue
- #805 issue
- #806 issue
- #807 issue
- #808 issue
- #809 issue
- #810 issue
- #811 issue
- #812 Test262Error extern class
- #813 private member name collision
- #815 Regression from patch-rescue commits

## Sprint 24 - v0.24.0

- Tags: `sprint/24`, `v0.24.0`
- Date range: 2026-03-27 (early morning) to 2026-03-27 (early morning)
- Goal: valueOf recursion fixes, depth limiter, String/prototype unblocking
- Worked on: Unblocked `String.prototype` and valueOf-heavy tests with recursion depth limiting, SyntaxError early-error checks, RangeError validation, JS-`undefined` emission fixes, and better runtime error classification.
- Baseline: ~15,182 pass / 49,840 total
- Final result: 14,169 pass → 14,616 pass / 49,880 total
- test262: `14,616 / 49,880`
- Delta: +447 pass (from session start of 14,169)

### Issues worked on

- #675 Dynamic import
- #696 Classify runtime errors
- #701 resolveWasmType recursion depth guard
- #733 RangeError validation
- #736 SyntaxError gaps / early error checks
- #737 Emit JS undefined instead of null for missing args/uninit vars
- #816 String/prototype compilation hang investigation

## Sprint 25 - v0.25.0

- Tags: `sprint/25`, `v0.25.0`
- Date range: 2026-03-27 (afternoon) to 2026-03-27 (afternoon)
- Goal: Wave 4 merge, class/elements unblocking, worker thread execution
- Worked on: Merged the wave-4 fixes: broader destructuring coverage, RegExp host-import methods, ref.cast guarding, removal of class/elements hang workarounds, and replacement of direct execution with a worker-thread Wasm pool.
- Baseline: 14,616 pass / 49,880 total
- Final result: 15,197 pass / 49,881 total (+1,028 session gain)
- test262: `15,197 / 49,881`
- Delta: +581 from sprint start, +1,028 from session start (14,169)

### Issues worked on

- #761 Rest/spread destructuring
- #763 RegExp runtime methods
- #766 Symbol.iterator protocol
- #778 Illegal cast failures
- #789 Null guard only throws TypeError for genuinely null refs
- #793 class/elements compilation hang investigation
- #815 Regression from patch-rescue commits
- #817 let/const in loop and try/catch bodies
- #818 additional issue
- #819 Multi-file compilation for _FIXTURE tests via compileMulti
- #820 TypeError / null dereference failures
- #821 additional issue
- #822 Wasm type mismatch compile errors (907 CE)
- #823 additional issue

## Sprint 26 - v0.26.0

- Tags: `sprint/26`, `v0.26.0`
- Date range: 2026-03-27 (evening) to 2026-03-28 (early)
- Goal: Exception tag fix, honest baseline, multi-file compilation
- Worked on: Exposed stale-cache inflation, fixed exception-tag and multi-file compilation issues, revisited arguments/default/null-deref behavior, and reset the project onto an honest worker-thread baseline.
- Baseline: 15,197 pass / 49,881 total (stale cache)
- Final result: 13,289 pass / 36,828 total (fresh run with worker threads)
- test262: sprint document records `13,289 / 36,828`; tag uses the nearest preserved boundary snapshot
- Delta: Honest baseline established — previous 15,197 was stale cache

### Issues worked on

- #779 Wrong values / NaN sentinel defaults / closure semantics
- #819 Multi-file compilation for _FIXTURE tests via compileMulti
- #820 TypeError / null dereference failures
- #822 Wasm type mismatch compile errors (907 CE)

## Sprint 27 - v0.27.0

- Tags: `sprint/27`, `v0.27.0`
- Date range: 2026-03-28 (morning/afternoon) to 2026-03-28 (morning/afternoon)
- Goal: Test262 infrastructure overhaul — precompiler, caching, vitest runner
- Worked on: Overhauled test262 infrastructure: standalone precompiler, two-phase compile/run flow, compiler pools sized to cores, batch JSONL writes, split compile/run logs, disk cache, Vitest integration, and targeted skip policy cleanup.
- Baseline: 13,289 pass (honest baseline)
- Final result: 17,612 pass / 48,086 total → 18,546 pass / 48,086 total
- test262: `17,612 -> 18,546 / 48,086`
- Delta: +4,323 to +5,257 from honest baseline

### Issues worked on

- #674 SharedArrayBuffer and Atomics
- #832 Upgrade to TypeScript 6.x to support Unicode 16.0.0 identifiers
- #833 Consider sloppy mode support for legacy octal escapes and non-strict code
- #834 ES2025 Set methods
- #835 Unknown extern class: Error types
- #836 Tagged templates with non-PropertyAccess tag expressions
- #837 Stage 3: Map/WeakMap upsert
- #838 BigInt64Array / BigUint64Array typed arrays

## Sprint 28 - v0.28.0

- Tags: `sprint/28`, `v0.28.0`
- Date range: 2026-03-28 (evening) to 2026-03-29 (early)
- Goal: PO analysis, runtime fix wave, closure semantics
- Worked on: Combined PO-guided analysis with runtime/compiler fixes for computed properties, accessor correctness, iterator close protocol, safe externref destructuring, closure capture semantics, callback detection, and runtime trap diagnostics.
- Baseline: 18,546 pass / 48,086 total
- Final result: 18,117 pass / 47,835 total → 18,186 pass / 47,782 total
- test262: `18,117 -> 18,186 / 47,782`
- Delta: -360 to -429 from peak (but more honest/complete runs)

### Issues worked on

- #848 Class computed property and accessor correctness
- #850 Object-to-primitive conversion missing: valueOf/toString not called
- #851 Iterator close protocol not implemented
- #852 Destructuring parameters cause null_deref and illegal_cast
- #857 wasm_compile: 'fn is not a function' in Array callback methods
- #859 Map.forEach callback captures are immutable snapshots
- #860 Promise executor and property-assigned functions not compiled as host callbacks
- #861 Playground: fs module externalized error in browser
- #862 Empty error message failures: iterator/destructuring step-err tests
- #863 decodeURI/encodeURI failures
- #864 WeakMap/WeakSet invalid key errors

## Sprint 29 - v0.29.0

- Tags: `sprint/29`, `v0.29.0`
- Date range: 2026-03-29 to 2026-03-29
- Goal: Team infrastructure, agent roles, checklists, runtime fixes
- Worked on: Mixed compiler fixes with team/process infrastructure: array callback semantics, for-of defaults, math methods, AggregateError, URI imports, WeakMap boxing, caller-side default-param refactor, ff-only merge rules, agent roles, and checklist-driven workflow.
- Baseline: 18,167 pass / 47,797 total
- Final result: 18,284 pass / 48,088 total
- test262: `18,284 / 48,088`
- Delta: +117 pass from baseline

### Issues worked on

- #825 Null dereference failures
- #827 Array callback methods: 'fn is not a function' Wasm compile error
- #836 Tagged templates with non-PropertyAccess tag expressions
- #839 return_call stack args and type mismatch in class constructors
- #840 Array.prototype.concat/push/splice require 0-arg support
- #841 Unsupported Math methods: sumPrecise, cosh, sinh, tanh, f16round
- #843 super keyword in object literals and edge cases
- #844 Unsupported new expression for built-in classes
- #846 assert.throws not thrown: built-in methods accept invalid arguments silently
- #847 for-await-of / for-of destructuring produces wrong values
- #849 Mapped arguments object does not sync with named parameters
- #854 Iterator protocol: null next/return/throw methods
- #856 Expected TypeError but got wrong error type
- #863 decodeURI/encodeURI failures
- #864 WeakMap/WeakSet invalid key errors
- #865 Console wrapper for fd_write in JavaScript environments
- #866 Regression: NaN sentinel interferes with toString/valueOf and explicit NaN arguments
- #867 Playground: interactive test262 conformance explorer with inline errors
- #868 Playground: lazy-load test262 tree and file contents on demand
- #869 Refactor default params: caller-side insertion instead of sNaN sentinel
- #870 Playground: Monaco web workers fail to load, UI freezes
- #871 Playground: default example throws WebAssembly.Exception at runtime
- #872 Test262 report data should only update on complete runs
- #873 Design dev branch protocol for agent merge workflow

## Sprint 30 - v0.30.0

- Tags: `sprint/30`, `v0.30.0`
- Date range: 2026-03-29 to 2026-03-29
- Goal: High-impact test262 fixes targeting 40%+ pass rate
- Worked on: Targeted the biggest remaining test262 wins: computed class properties/accessors, for-of destructuring, `assert.throws` validation, array callback methods, destructuring null-deref repair, plus verifyProperty diagnosis and stronger merge/test discipline.
- Baseline: 18,284 pass / 48,088 total (38.0%)
- Final result: 18,599 pass / 48,088 total (38.7%)
- test262: `18,599 / 48,088`
- Delta: +315 pass, -64 CE

### Issues worked on

- #822 Wasm type mismatch compile errors (907 CE)
- #824 Compilation timeouts: tests exceed compile limit
- #825 Null dereference failures
- #827 Array callback methods: 'fn is not a function' Wasm compile error
- #846 assert.throws not thrown: built-in methods accept invalid arguments silently
- #847 for-await-of / for-of destructuring produces wrong values
- #848 Class computed property and accessor correctness
- #850 Object-to-primitive conversion missing: valueOf/toString not called
- #852 Destructuring parameters cause null_deref and illegal_cast
- #857 wasm_compile: 'fn is not a function' in Array callback methods
- #866 Regression: NaN sentinel interferes with toString/valueOf and explicit NaN arguments

## Sprint 31 - v0.31.0

- Tags: `sprint/31`, `v0.31.0`
- Date range: 2026-03-30 to 2026-03-30
- Goal: Re-apply sprint-31 fixes without regressions. Test262 between EVERY merge.
- Worked on: Re-ran the previous sprint under a stricter safe-first protocol, focusing on tail-call guards, sNaN/ToPrimitive fixes, WasmGC iterable support, equivalence-test infrastructure, and “test262 after every merge” process enforcement before the sprint was suspended.
- Baseline: 15,246 pass / 48,174 total (31.7%) — honest baseline, no cache, negative test bug fixed
- Final result: baseline `15,246 / 48,174`; latest archived full run `15,155 / 48,174`
- test262: baseline `15,246 / 48,174`; latest archived full run `15,155 / 48,174`

### Issues worked on

- #822 Wasm type mismatch compile errors (907 CE)
- #826 Illegal cast failures
- #828 Unexpected undefined AST node in compileExpression
- #839 return_call stack args and type mismatch in class constructors
- #851 Iterator close protocol not implemented
- #854 Iterator protocol: null next/return/throw methods
- #862 Empty error message failures: iterator/destructuring step-err tests
- #866 Regression: NaN sentinel interferes with toString/valueOf and explicit NaN arguments
- #868 Playground: lazy-load test262 tree and file contents on demand
- #876 Sprint dashboard — kanban board, burndown, agent status, metrics
- #877 Agile criteria — Definition of Ready, Definition of Done, velocity tracking
- #891 Apply test262 infrastructure learnings to equivalence tests
