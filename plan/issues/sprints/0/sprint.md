# Sprint 0 -- Pre-sprint historical issues

**Date**: Pre-sprint historical bucket
**Goal**: Preserve work that predates Sprint 1 under a single synthetic sprint id for filtering and audit purposes

## Context

Sprint `0` is not a real sprint. It is a synthetic bucket that collects all
historical issues from before the numbered sprint process existed.

Historical labels such as:

- `Session`
- `Dep-driven`
- `Wave`
- `W6-Wave1`

were normalized to `sprint: 0` so pre-sprint issues can be filtered
consistently across the dashboard, sprint tables, and audits.

## Notes

- Do not use Sprint 0 for new work.
- New unscheduled work belongs in `Backlog`.
- New scheduled work should use a real numbered sprint.

<!-- GENERATED_ISSUE_TABLES_START -->
## Issue Tables

_Generated from issue files. Update issue `status`, then rerun `node scripts/sync-sprint-issue-tables.mjs`._

### Done

| Issue | Title | Priority | Status |
|---|---|---|---|
| #1 | Issue 1: do-while loops |  | done |
| #2 | Issue 2: switch statements |  | done |
| #3 | Issue 3: Arrays |  | done |
| #4 | Issue 4: for-of loops |  | done |
| #5 | Issue 5: Enums |  | done |
| #6 | Issue 6: Classes |  | done |
| #7 | Issue 7: Closures / Arrow functions |  | done |
| #8 | Issue 8: Generics |  | done |
| #9 | Issue 9: for-in loops |  | done |
| #10 | Issue 10: DOM Support |  | done |
| #11 | Issue 11: Arrow Function Callbacks |  | done |
| #12 | Issue 12: VS Code-like IDE layout for playground |  | done |
| #13 | Issue 13: Template Literals |  | done |
| #14 | Issue 14: String Methods |  | done |
| #15 | Issue 15: Ternary / Conditional Expression |  | done |
| #16 | Issue 16: Optional Chaining and Nullish Coalescing |  | done |
| #17 | Issue 17: Destructuring |  | done |
| #18 | Issue 18: Spread and Rest Operators |  | done |
| #19 | Issue 19: Type Narrowing and Union Types |  | done |
| #20 | Issue 20: Async/Await and Promises |  | done |
| #21 | Issue 21: Array Methods |  | done |
| #22 | Issue 22: Multi-file Modules and Imports |  | done |
| #23 | Issue 23: Bitwise operators |  | done |
| #24 | Issue 24: Exponentiation operator |  | done |
| #25 | Issue 25: Fix f32.const opcode in binary emitter |  | done |
| #26 | Issue 26: Array methods via host imports |  | done |
| #27 | Issue 27: Try/catch/throw |  | done |
| #28 | Issue 28: Multi-file module compilation |  | done |
| #29 | Issue 29: Investigate failing tests |  | done |
| #30 | Issue 30: Async/await and Promises |  | done |
| #31 | Issue 31: Default number type to i32, promote to f64 only when needed |  | done |
| #32 | Issue 32: Capacity-based array representation with `array.copy` |  | done |
| #33 | Issue 33: Relocatable Wasm Object File (.o) Emission |  | done |
| #34 | Issue 34: Multi-Memory Module Linker with Isolation Validation |  | done |
| #35 | Issue #35: Class inheritance with extends and super |  | done |
| #36 | Issue #36: Static class members |  | done |
| #37 | Issue #37: Getter/Setter Properties on User-Defined Classes |  | done |
| #38 | Issue 38: Implement `instanceof` operator |  | done |
| #39 | Issue 39: Labeled Break and Continue |  | done |
| #40 | Issue 40: String Enums |  | done |
| #41 | Issue 41: typeof as Expression |  | done |
| #42 | Issue #42: Comma operator support |  | done |
| #43 | Issue 43: void Expression |  | done |
| #44 | Issue #44: Source Map Generation |  | done |
| #45 | Issue #45 — Error reporting with source locations |  | done |
| #46 | Issue 46: Linear-memory compilation backend |  | done |
| #47 | Issue 47: importedStringConstants support |  | done |
| #48 | Issue 48: Cache string literals in locals |  | done |
| #49 | Issue 49: Default parameter values |  | done |
| #50 | Issue 50: Nullish and logical assignment operators |  | done |
| #51 | Issue 51: Functional array methods (filter, map, reduce, forEach, find) |  | done |
| #52 | Issue 52: String.split() method |  | done |
| #53 | Issue 53: Numeric separators |  | done |
| #54 | Issue 54: Map and Set collections |  | done |
| #55 | Issue 55: Function expressions |  | done |
| #56 | Issue 56: Tuples |  | done |
| #57 | Issue 57: Class expressions |  | done |
| #58 | Issue 58: Iterators and for...of with custom iterables |  | done |
| #59 | Issue 59: Abstract classes |  | done |
| #60 | Issue 60: RegExp via host imports |  | done |
| #61 | Issue 61: Object.keys / Object.values / Object.entries |  | done |
| #62 | Issue 62: JSON.parse / JSON.stringify via host |  | done |
| #63 | Issue 63: Promise.all / Promise.race |  | done |
| #64 | Issue 64: Generators and yield |  | done |
| #65 | Issue 65: Computed property names |  | done |
| #66 | Issue 66: Security design doc — runtime import hardening |  | done |
| #67 | Issue 67: Closed import objects — replace Proxy with compiler manifest |  | done |
| #68 | Issue 68: DOM containment — scope wasm module access to a subtree |  | done |
| #69 | Issue 69: Safe mode — restrict TypeScript to a secure subset |  | done |
| #70 | Issue 70: Fast mode — optimize for performance with restricted TypeScript | low | done |
| #71 | Issue 71: Fast mode — WasmGC-native strings |  | done |
| #72 | Issue 72: Fast mode — WasmGC-native arrays |  | done |
| #73 | Issue 73: Benchmark — JS vs host-call vs GC-native vs linear-memory performance |  | done |
| #74 | Issue 74: WASM SIMD support for string and array operations | low | done |
| #75 | Issue 75: Slice-based string views for substring/trim/slice |  | done |
| #76 | Issue 76: Rope/cons-string for O(1) concatenation |  | done |
| #77 | Issue 77: Object literals, spread, and structural typing |  | done |
| #78 | Issue 78: Standard library coverage — builtins and static methods |  | done |
| #79 | Issue 79: Gradual typing — boxed `any` with runtime dispatch | low | done |
| #80 | Issue 80: JS file compilation via `.d.ts` types and TS inference |  | done |
| #81 | Issue 81: npm package resolution and tree-shaking | low | done |
| #82 | Issue 82: Study V8, SpiderMonkey, Zena, and AssemblyScript implementation strategies |  | done |
| #83 | Issue 83: Test262 conformance subset |  | done |
| #84 | Issue 84: `var` hoisting support |  | done |
| #85 | Issue 85: Variadic `Math.min` / `Math.max` |  | done |
| #86 | Issue 86: `new Array()` constructor expression |  | done |
| #87 | Issue 87: Math.round negative zero preservation |  | done |
| #88 | Issue 88: Test262 coverage — language/expressions |  | done |
| #89 | Issue 89: Test262 coverage — language/statements |  | done |
| #90 | Issue 90: Test262 coverage — built-ins/Array |  | done |
| #91 | Issue 91: Test262 coverage — built-ins/Number |  | done |
| #92 | Issue 92: Test262 coverage — language/types (coercion) |  | done |
| #93 | Issue 93: Test262 coverage — built-ins/Object |  | done |
| #94 | Issue 94: Test262 coverage — language/function-code |  | done |
| #95 | Issue 95: Test262 coverage — built-ins/isNaN + isFinite |  | done |
| #96 | Issue 96: Test262 coverage — built-ins/JSON |  | done |
| #97 | Issue 97: NaN/undefined/null truthiness in boolean contexts |  | done |
| #98 | Issue 98: Proper ToInt32 modular arithmetic for bitwise operations |  | done |
| #99 | Issue 99: Externref arithmetic, comparison, and control flow |  | done |
| #130 | Issue 130: Usage-based shape inference + call/apply inlining | low | done |
| #138 | Issue #138: valueOf/toString coercion on comparison operators | medium | done |
| #139 | Issue #139: valueOf/toString coercion on arithmetic operators | medium | done |
| #140 | Issue #140: Object computed property names not working at runtime | low | done |
| #141 | Issue #141: Tagged template literal runtime failures | low | done |
| #142 | Assignment destructuring failures | medium | done |
| #143 | Issue #143: for-loop edge cases | low | done |
| #146 | - Unknown identifier errors from scope/hoisting issues | medium | done |
| #149 | Unsupported call expression patterns | high | done |
| #152 | Setter return value error in allowJs mode | low | done |
| #153 | - Iterator protocol for destructuring and for-of | medium | done |
| #165 | Issue #165: function statement hoisting and edge cases | low | done |
| #167 | typeof edge cases | low | done |
| #170 | Class expression/declaration edge cases | low | done |
| #171 | Boolean() edge cases | low | done |
| #173 | Computed property names in class declarations | medium | done |
| #174 | Bug: BigInt cross-type comparison and arithmetic failures | low | done |
| #178 | Wasm validation errors: type mismatches in emitted binary | medium | done |
| #190 | Unsupported assignment target patterns | medium | done |
| #192 | Computed property names: compile errors in class and object contexts | low | done |
| #202 | Variable scope and hoisting: 'Cannot find name' / 'Unknown identifier' | low | done |
| #204 | Array literal compile errors | low | done |
| #227 | Issue #227: BigInt comparison with Infinity causes float-unrepresentable trap | medium | done |
| #228 | Issue #228: BigInt equality/strict-equality with Number and Boolean | medium | done |
| #229 | Issue #229: Tagged template cache: array out of bounds on top-level repeated calls | medium | done |
| #230 | Issue #230: Object computed property names with variable keys at runtime | medium | done |
| #232 | Issue #232: Unsupported call expression -- method calls on object literals | medium | done |
| #234 | Issue #234: ClassDeclaration in nested/expression positions (remaining 681 errors) | high | done |
| #235 | Issue #235: Function.name property access (380 compile errors) | high | done |
| #237 | Issue #237: WebAssembly type mismatch -- BigInt i64 vs externref | medium | done |
| #238 | Issue #238: Class expression new -- `new (class { ... })()` pattern | medium | done |
| #239 | Issue #239: Element access on struct types (bracket notation) | medium | done |
| #241 | Issue #241: Yield expression in strict mode / module context | low | done |
| #242 | Issue #242: Computed property names in class declarations (remaining 57 errors) | low | done |
| #243 | Issue #243: Unsupported assignment target patterns | medium | done |
| #244 | Issue #244: `in` operator runtime failures | medium | done |
| #249 | Issue #249: Miscellaneous runtime failures -- remaining small fixes | medium | done |
| #254 | Issue #254: Private class fields and methods (#field) | medium | done |
| #260 | ClassDeclaration + call expression combined errors | high | done |
| #261 | Issue #261: ClassDeclaration + new expression for anonymous classes | medium | done |
| #262 | Issue #262: Argument type assignability -- allowJs flexibility for test262 | high | done |
| #263 | Issue #263: Property does not exist on type -- dynamic property access | medium | done |
| #264 | Issue #264: Element access (bracket notation) on struct types | low | done |
| #265 | Issue #265: Computed property names in class declarations (TypeScript diagnostic) | low | done |
| #266 | Issue #266: Unknown identifier -- scope resolution for multi-variable patterns | medium | done |
| #267 | Issue #267: Yield expression outside of generator function | low | done |
| #268 | Issue #268: Iterator protocol -- Type must have a Symbol.iterator method | medium | done |
| #269 | Issue #269: Setter return value diagnostic suppression | low | done |
| #270 | Issue #270: Strict mode reserved words -- let, yield, package, etc. | low | done |
| #271 | Issue #271: Cannot find name -- missing harness or global declarations | low | done |
| #274 | Issue #274: Property access on function type -- .name, .length, .call, .apply | medium | done |
| #275 | Issue #275: Left side of comma operator warning blocks compilation | low | done |
| #276 | Issue #276: Computed property name must be of assignable type | low | done |
| #277 | Issue #277: WebAssembly type mismatch -- local.set externref vs concrete types | medium | done |
| #279 | Issue #279: Arrow function compile errors -- parameter and body patterns | medium | done |
| #280 | Issue #280: Function expression compile errors -- name binding and hoisting | medium | done |
| #281 | Issue #281: Object literal property patterns -- shorthand, spread, methods | medium | done |
| #282 | Issue #282: Variable declaration compile errors -- complex initializers | low | done |
| #283 | Issue #283: Compound assignment compile errors -- type coercion gaps | medium | done |
| #284 | Issue #284: For-of compile errors -- destructuring and non-array iterables | low | done |
| #287 | Issue #287: Generator function compile errors -- yield in nested contexts | medium | done |
| #288 | Issue #288: Try/catch/finally compile errors -- complex patterns | medium | done |
| #289 | Issue #289: For-in compile errors -- property enumeration edge cases | low | done |
| #291 | Issue #291: In operator compile errors -- dynamic property checks | medium | done |
| #292 | Issue #292: Runtime failures -- for-loop incorrect computed values | high | done |
| #293 | Issue #293: Runtime failures -- class method incorrect results | high | done |
| #294 | Issue #294: Runtime failures -- assignment expression evaluation order | high | done |
| #295 | Issue #295: Runtime failures -- comparison operators with type coercion | high | done |
| #296 | Issue #296: Runtime failures -- strict equality edge cases | high | done |
| #297 | Issue #297: Runtime failures -- switch statement fall-through | medium | done |
| #298 | Issue #298: Runtime failures -- function statement edge cases | medium | done |
| #299 | Issue #299: Runtime failures -- equals/does-not-equals loose comparison | medium | done |
| #300 | Issue #300: Runtime failures -- object to primitive conversion | high | done |
| #301 | Issue #301: Runtime failures -- float unrepresentable in integer range | medium | done |
| #302 | Issue #302: Runtime failures -- Math.min/max edge cases | medium | done |
| #303 | Issue #303: Runtime failures -- parseInt edge cases | medium | done |
| #304 | Issue #304: Runtime failures -- unary minus and return edge cases | medium | done |
| #305 | Issue #305: Runtime failures -- computed property names and types/reference | medium | done |
| #306 | Issue #306: Prefix/postfix increment/decrement compile errors | high | done |
| #307 | Issue #307: Promise.all and Promise.race compile errors | low | done |
| #308 | Issue #308: Addition operator compile errors -- string/number coercion | high | done |
| #309 | Issue #309: Expand test262 harness includes -- propertyIsEnumerable, fnGlobalObject | low | done |
| #310 | Issue #310: Reduce skip filters -- re-evaluate conservative skips | low | done |
| #311 | Issue #311: Test262 category expansion -- built-ins/String/prototype new methods | low | done |
| #312 | Issue #312: Test262 category expansion -- built-ins/Number methods | low | done |
| #313 | Issue #313: Test262 category expansion -- language/expressions new categories | low | done |
| #315 | Issue #315: Wasm validation error audit -- systematic fix for type mismatches | high | done |
| #316 | Issue #316: Runtime failure -- array element access out of bounds | medium | done |
| #317 | [ts2wasm] Codegen: Unused `$AnyValue` preamble type + duplicate export for `main` | critical | done |
| #318 | [ts2wasm] Codegen: Infer parameter types from call-site arguments for untyped functions | medium | done |
| #319 | [ts2wasm] Codegen: Inline single-use function type signatures in WAT output | low | done |
| #321 | [ts2wasm] Bug: Collection functions don't scan top-level statements (`__module_init`) | critical | done |
| #323 | [ts2wasm] Native type annotations for performance optimization | low | done |
| #329 | - Object.setPrototypeOf support | low | done |
| #331 | - Strict mode arguments/eval identifier restriction | low | done |
| #337 | - Null property access at runtime | medium | done |
| #339 | Async function and await support | high | done |
| #340 | - Error throwing and try/catch/finally | high | done |
| #343 | Narrow prototype chain skip filter in test262 runner | medium | done |
| #344 | - Wrapper constructors (new Number, new String, new Boolean) | medium | done |
| #345 | - Symbol.iterator and iterable protocol | medium | done |
| #350 | Symbol type skip filter narrowing | medium | done |
| #351 | Async iteration / for-await-of | medium | done |
| #353 | - For-of with generators and custom iterators | medium | done |
| #354 | Narrow Reflect skip filter in test262 runner |  | done |
| #356 | - Closure-as-value in assert and array-like objects | low | done |
| #357 | - IIFE tagged templates | low | done |
| #359 | - Object mutability methods (Object.freeze/seal/preventExtensions) | low | done |
| #360 | - JSON.stringify result comparison | low | done |
| #361 | Runtime `in` operator for property checks |  | done |
| #362 | typeof on member expressions | medium | done |
| #363 | - Tagged template .raw property and identity | low | done |
| #364 | - call/apply on arrow functions | low | done |
| #365 | Collection mutation during for-of (15 skip) |  | done |
| #366 | - Object.create support | low | done |
| #370 | - WeakMap and WeakSet (skip filter narrowing) | low | done |
| #371 | - import.meta support | low | done |
| #372 | - String.prototype.matchAll | low | done |
| #373 | Object as loop condition / falsy value handling | medium | done |
| #374 | - Miscellaneous small patterns | low | done |
| #375 | - Unsupported expression: SuperKeyword | medium | done |
| #376 | - Decorator syntax support | low | done |
| #383 | - Label not allowed / let declaration errors | low | done |
| #384 | - replaceAll and other missing string methods | low | done |
| #387 | Unsupported call expression (2356 CE) | high | done |
| #388 | - Element access on externref (104 CE) | high | done |
| #389 | - Element access on class instances (76 CE) | high | done |
| #390 | - Assignment to non-array types (70 CE) | medium | done |
| #391 | Numeric index signature on object types | medium | done |
| #392 | - Unknown field access on class structs (18 CE) | medium | done |
| #393 | - Compound assignment on externref element access (13 CE) | medium | done |
| #394 | Destructuring produces wrong return values | critical | done |
| #395 | - Runtime 'fn is not a function' errors (70 FAIL) | high | done |
| #396 | Null pointer dereference in destructuring (118 FAIL) | high | done |
| #397 | - assert.throws test support (952 SKIP) | medium | done |
| #398 | Private class fields/methods return wrong values (98 FAIL) | high | done |
| #399 | Prototype method calls return wrong values (72 FAIL) | high | done |
| #400 | - Endo/SES-like freezing/locking of insecure language features | low | done |
| #401 | Wasm validation errors | critical | done |
| #402 | Negative tests: expected SyntaxError not raised | medium | done |
| #403 | import.source meta-property errors | low | done |
| #404 | Compound assignment on unresolvable property type | medium | done |
| #406 | 'base' is possibly null errors | medium | done |
| #409 | Unsupported call expression -- spread, optional chaining, super, property methods | critical | done |
| #410 | Stack fallthru mismatch -- control flow branches leave wrong stack state | critical | done |
| #411 | struct.new stack mismatch -- class/object construction emits wrong argument count | critical | done |
| #414 | Super keyword unsupported in remaining positions | low | done |
| #415 | Logical assignment struct resolution failure | medium | done |
| #418 | Missing SyntaxError validation -- invalid code compiles successfully | high | done |
| #419 | Null pointer in destructuring -- dereferencing null struct during pattern matching | high | done |
| #422 | Generator type mismatch errors (19 CE) | medium | done |
| #424 | Logical assignment on unresolved struct type (14 CE) | medium | done |
| #426 | Compound assignment on non-ref element (11 CE) | low | done |
| #429 | Undeclared variable access should produce ReferenceError (71 tests) | high | done |
| #430 | String-to-number coercion for non-addition arithmetic operators (36 CE) | medium | done |
| #435 | Logical/conditional operators must preserve object identity (16 fail) | medium | done |
| #437 | Cannot find module empty_FIXTURE.js -- test infrastructure gap (38 CE) | low | done |
| #441 | RuntimeError: dereferencing a null pointer -- residual after #419 (88 fail) | high | done |
| #442 | RuntimeError: illegal cast at runtime (6 fail) | low | done |
| #443 | Expected ReferenceError but execution succeeded (6 fail) | low | done |
| #445 | Wasm validation: call args missing (72 CE) | medium | done |
| #446 | Wasm validation: call_ref type mismatch (56 CE) | medium | done |
| #447 | Wasm validation: stack fallthru type mismatch -- residual after #410 (48 CE) | medium | done |
| #450 | Performance benchmarks: JS runtime vs precompiled Wasm | medium | done |
| #451 | Compile lodash to Wasm | low | done |
| #452 | Compile TypeScript compiler to Wasm | medium | done |
| #453 | Compile Three.js to Wasm | low | done |
| #459 | Object.defineProperty getter/setter subset | medium | done |
| #460 | Object.create for known prototypes | medium | done |
| #461 | Array of structs: array.new_default fails for non-defaultable ref types | high | done |
| #463 | Self-referencing struct types for linked lists / fiber trees | high | done |
| #465 | Inline small functions to reduce call overhead | medium | done |
| #467 | Constant folding for compile-time evaluable expressions | low | done |
| #470 | Fix f64/i32-to-externref type coercion in arithmetic expressions | critical | done |
| #471 | Symbol support for test262 conformance (1,485 skipped tests) | high | done |
| #472 | Async/await support for test262 conformance (1,405 skipped tests) | high | done |
| #473 | Array.prototype method .call/.apply support (852 skipped tests) | high | done |
| #475 | Narrow negative test skip — 892 tests improperly classified | high | done |
| #476 | Narrow hasOwnProperty.call skip — 647 tests | high | done |
| #478 | assert.throws side-effect assertions — 342 tests | medium | done |
| #479 | Narrow wrapper constructor skip — 155 tests | medium | done |
| #480 | String() indexer in assert — 116 tests | low | done |
| #481 | Well-known Symbol.iterator as compile-time struct field (1,327 tests) | critical | done |
| #482 | Well-known Symbol.toPrimitive for type coercion (113 tests) | high | done |
| #483 | Symbol() constructor and typeof symbol (207 tests) | medium | done |
| #484 | Well-known Symbol.species for constructor delegation (52 tests) | medium | done |
| #486 | Well-known Symbol.toStringTag and Symbol.hasInstance (22 tests) | low | done |
| #487 | User Symbol as property key via tagged struct variant (~60 tests) | low | done |
| #489 | General Function.prototype.call/apply (822 tests) | critical | done |
| #491 | Remove stale unary +/- null/undefined skip filter (480 tests) | medium | done |
| #492 | delete operator via undefined sentinel (288 tests) | medium | done |
| #495 | Array-like objects with numeric keys (77 tests) | low | done |
| #496 | eval() and new Function() source transform for test262 (533 tests) | medium | done |
| #497 | Dynamic import() via host-side module loading (442 tests) | medium | done |
| #499 | with statement via static identifier dispatch (94 tests) | low | done |
| #500 | Remove cross-realm skip filter (33 tests) | low | done |
| #502 | Quick wins: narrow stale skip filters (~1,160 tests) | critical | done |
| #503 | Runner safe-write: don't corrupt report on crash | high | done |
| #504 | Auto-generated README feature coverage + benchmark tables | high | done |
| #505 | Playground: integrate test262 results into test262 browser panel | high | done |
| #506 | Remove redundant conformance-report.html | low | done |
| #508 | ts2wasm-jwt: pure Wasm JWT decode + HS256 verify (showcase package) | critical | done |
| #509 | Post-fix error analysis: create issues from fresh test262 run | high | done |
| #510 | TS parse errors from test wrapping (78 CE) | high | done |
| #511 | Wasm validation: call/call_ref type mismatch (~514 CE) | critical | done |
| #512 | RuntimeError: illegal cast (~683 FAIL) | critical | done |
| #513 | Fix any-typed equality: object/ref identity broken in __any_strict_eq and externref path | critical | done |
| #514 | Generator/async-gen 'options is not defined' (~684 CE) | critical | done |
| #515 | Wasm validation: uninitialized non-defaultable local + struct.get/set type errors (~470 CE) | high | done |
| #516 | struct.new argument count mismatch in class constructors (1,781 CE) | high | done |
| #517 | Unsupported call expression: class/generator/built-in method calls (2,164+ CE) | high | done |
| #518 | Cannot destructure: not an array type (74 CE) | medium | done |
| #519 | Internal error: targetLocal is not defined (66 CE) | high | done |
| #521 | Yield keyword not recognized in nested contexts (53 CE) | medium | done |
| #522 | Object.keys() requires struct type argument (43 CE) | medium | done |
| #523 | Internal compiler errors: undefined property access (59 CE) | medium | done |
| #524 | Type '{}' missing Function properties (40 CE) | low | done |
| #525 | RuntimeError: illegal cast (683 FAIL) | high | done |
| #526 | RuntimeError: dereferencing a null pointer (129 FAIL) | high | done |
| #527 | Fix test262 script: use tsx instead of node | critical | done |
| #528 | Test262 runner -- show progress when starting each batch | low | done |
| #529 | Speed up test262 runner with parallel workers + compilation cache | medium | done |
| #530 | Unsupported call expression — remaining 1,745 CE | critical | done |
| #532 | Wasm validation: call type mismatch -- string addition folded to numeric | high | done |
| #533 | Wasm validation: struct.get on null ref type (125 CE) | medium | done |
| #534 | Fix addUnionImports func index shift for parent function bodies during nested closure compilation | critical | done |
| #535 | 'delete' cannot be called on identifier in strict mode (20 CE) | medium | done |
| #536 | Spread types may only be created from object types (16 CE) | medium | done |
| #537 | TypeScript diagnostic suppressions for test262 (62 CE) | medium | done |
| #538 | PrivateIdentifier + new.target unsupported (19 CE) | medium | done |
| #540 | Array out of bounds guards (14+ FAIL) | medium | done |
| #541 | Async flag skip filter blocks 1,311 tests | high | done |
| #542 | Negative test skip blocks 892 tests | high | done |
| #543 | propertyHelper.js + hasOwnProperty.call skip filters (1,294 tests) | high | done |
| #544 | Remove/narrow stale skip filters | medium | done |
| #545 | Hang-risk skip filters: for-of generators + throw/try (139 tests) | medium | done |
| #546 | Remaining skip filters: small patterns (460 tests) | low | done |
| #547 | Restore search/filter UI in report.html | low | done |
| #548 | Security: WAT string injection + memory bounds validation | high | done |
| #549 | Security: playground path traversal via symlinks | high | done |
| #550 | Security: XSS via error messages in report.html | medium | done |
| #553 | Division by zero missing in constant folding (tryStaticToNumber) | low | done |
| #554 | JSONL concurrent write corruption from parallel workers | medium | done |
| #555 | Cache invalidation misses uncommitted source changes |  | done |
| #556 | Performance: O(n^2) struct deduplication in ensureStructForType |  | done |
| #557 | Performance: repeated instruction tree traversal for index shifting | medium | done |
| #558 | Performance: add hash-based function type deduplication | medium | done |
| #560 | BigInt + Number mixed arithmetic leaves stack dirty (2 CE) | medium | done |
| #562 | Addition/subtraction valueOf coercion + Math special values (17 FAIL) | high | done |
| #564 | Worker crashed -- 572 tests lost to worker process crashes | medium | done |
| #565 | returned 0: wrong return value (4,259 FAIL) | critical | done |
| #571 | - struct.new argument count mismatch (231 CE) | high | done |
| #573 | struct.get on null ref in class tests (751 CE + 223 null pointer FAIL) | critical | done |
| #575 | Class statement tests all return 0 (651 FAIL) | critical | done |
| #578 | WASI target: console.log -> fd_write, process.exit -> proc_exit | medium | done |
| #581 | struct.get on ref.null in Wasm:test function (177 CE) | high | done |
| #582 | local.set type mismatch in C_method (84 CE) | high | done |
| #583 | Stack not empty at fallthrough in Wasm:test (82 CE) + stack-related fails | high | done |
| #584 | Null pointer dereference in 361 tests (unknown function) | high | done |
| #585 | RuntimeError: illegal cast (70 FAIL) | medium | done |
| #586 | Deduplicate array method callbacks (~1,500 lines) | medium | done |
| #587 | Deduplicate destructuring code (~1,300 lines) | medium | done |
| #588 | Finally block executes 2-3 times instead of once | high | done |
| #590 | Generator for-of-string missing return depth update | medium | done |
| #591 | Split expressions.ts (24,427 lines) into focused modules | medium | done |
| #592 | Consolidate AST collection passes into single visitor | medium | done |
| #593 | - Minor security/correctness fixes across emit + runtime | low | done |
| #594 | Mark WasmGC struct types as final for V8 devirtualization | medium | done |
| #595 | Integer loop inference: emit i32 loop counters in default mode | medium | done |
| #596 | Eliminate unnecessary ref.cast when type is statically known | medium | done |
| #597 | Type-specialized arithmetic: skip AnyValue for known types | medium | done |
| #598 | Typed export signatures: avoid externref at module boundary | high | done |
| #599 | - Self-contained WasmGC strings: eliminate wasm:js-string dependency | critical | done |
| #600 | Component Model output: WIT interfaces from TypeScript types | high | done |
| #601 | Binaryen wasm-opt post-processing pass | medium | done |
| #602 | - Tail call optimization: emit return_call for recursive functions | medium | done |
| #603 | - Remove ~5,100 stale skip filters blocking already-implemented features | critical | done |
| #604 | Narrow async flag skip filter (1,311 tests) | high | done |
| #605 | Narrow negative test skip filter (892 tests) | medium | done |
| #606 | Test harness gaps: propertyHelper.js, assert.throws, String() indexer (1,105 tests) | high | done |
| #607 | Remaining small skip patterns (302 tests) | medium | done |
| #608 | TypedArray support (108 tests) | medium | done |
| #609 | Test262 runner doesn't complete all 53,010 tests (13,323 missing) | high | done |
| #611 | Compiler crash: Cannot read 'kind' of undefined (2,995 CE) | critical | done |
| #612 | Symbol.asyncIterator required but not implemented (367+ CE) | high | done |
| #613 | Property 'index' does not exist on string[] (206 CE) | high | done |
| #614 | Unsupported new expression for ArrayBuffer/DataView (203+ CE) | medium | done |
| #616 | Cannot extend interface 'Iterator' (137 CE) | medium | done |
| #617 | Wasm validation: not enough arguments for drop (109 CE) | medium | done |
| #618 | Wrong return value: 7,912 tests return 0 instead of expected result | critical | done |
| #619 | Residual undefined .kind crashes after null guard (4,230 CE) | high | done |
| #620 | ENOENT: double test/ path in test262 runner (559 CE) | high | done |
| #621 | Unsupported call expression (1,692 CE) | high | done |
| #622 | Null pointer dereference at runtime (707 FAIL) | high | done |
| #623 | Worker timeout: 559 tests killed after 60s | high | done |
| #624 | Wasm struct type errors: struct.new/struct.get mismatches (1,092 CE) | high | done |
| #625 | Wasm local.set type mismatch (552 CE) | high | done |
| #626 | Wasm call/call_ref type mismatch (378 CE) | medium | done |
| #627 | Wasm stack underflow: not enough arguments (354 CE) | critical | done |
| #628 | Yield expression outside generator (283 CE) | high | done |
| #629 | Destructuring in generator/class methods fails silently (2,444 FAIL) | critical | done |
| #630 | Temporal API tests fail (888 FAIL) | medium | done |
| #631 | Prototype chain tests fail (625 FAIL) | high | done |
| #632 | RegExp test failures (367 FAIL) | high | done |
| #633 | Object.defineProperty tests fail (297 FAIL) | high | done |
| #634 | Accessor/getter/setter side effects not triggered (118 FAIL) | medium | done |
| #637 | Create walkInstructions utility (eliminates 5 duplicate walkers) | medium | done |
| #643 | Test262 runner should not overwrite report until run completes | medium | done |
| #645 | Add testTypedArray.js to allowed includes (1,731 skip) | high | done |
| #646 | Residual undefined .kind: more AST node handlers (5,329 CE) | high | done |
| #648 | Residual illegal cast (988 FAIL) | high | done |
| #653 | Timeout epidemic: 6,715 tests (Temporal + statements) | high | done |
| #654 | Missing property diagnostics (1,116 CE) | high | done |
| #656 | Null pointer dereferences (2,050 FAIL) | high | done |
| #657 | Yield outside generator residual (411 CE) | medium | done |
| #658 | local.set type mismatch residual (659 CE) | medium | done |
| #659 | Call type mismatch residual (609 CE) | medium | done |
| #660 | Capture first failing assert in test output for returned-0 tests | high | done |
| #662 | For/for-of/destructuring timeouts (3,330 FAIL) | high | done |
| #663 | - Null pointer dereferences from missing property access (2,050 FAIL) | high | done |
| #664 | Use source maps for runtime error line numbers in test262 report | critical | done |
| #666 | Suppress 'await outside async' diagnostic (146 CE) | medium | done |
| #667 | 'hint is not defined' in toPrimitive coercion (71 CE) | medium | done |
| #669 | eval() and new Function() support | high | done |
| #677 | Full property descriptor support (writable/enumerable/configurable) | high | done |
| #689 | Dynamic worker pool: memory-aware scaling with dead worker recovery | high | done |
| #690 | Streaming test results with incremental report updates and zero-copy worker IPC | high | done |
| #691 | Pipeline architecture: interleave stages and minimize memory pressure | high | done |
| #692 | Async pipelined execution: overlap load/compile/run stages | medium | done |
| #694 | Migrate test262 runner to vitest with per-test disk cache | low | done |
| #695 | Emit proper exceptions for TypeError/ReferenceError/etc (4,738 FAIL) | high | done |
| #698 | - Call type mismatch residual (1,044 CE) | medium | done |
| #702 | Residual null pointer dereferences: 2,767 runtime failures | critical | done |
| #703 | Negative tests: strict-mode validation for ES-spec parse errors | medium | done |
| #704 | Wasm validation: immutable global set (284 CE) | high | done |
| #710 | RuntimeError: unreachable executed (173 FAIL) | medium | done |
| #711 | Unsupported new expression: new Function() (106 CE) | medium | done |
| #712 | Unsupported expression: MetaProperty import.meta (70 CE) | medium | done |
| #713 | Cannot destructure: unknown type (69 CE) | low | done |
| #715 | - Fix 3,622 test262 crashes: emitNullGuardedStructGet missing ctx parameter | critical | done |
| #716 | Regression: null-guard TypeError throws cause pass-to-fail in struct-path property access | critical | done |
| #717 | Regression: import.source/defer stub breaks 117 negative parse tests | high | done |
| #718 | Duplicate of #716 — null-guard TypeError regression | critical | done |
| #720 | Wasm validation: i32.add expects i32, got f64 (96 CE) | medium | done |
| #721 | Residual negative test false-pass (2,564 FAIL) | high | done |
| #723 | - TDZ violations: throw ReferenceError before let/const init (230 FAIL) | high | done |
| #726 | - TypeError regression: ref.cast guard returns ref.null for valid objects (1,948 tests) | critical | done |
| #727 | - Sub-classify assertion failures (11,480 tests return wrong values) | high | done |
| #728 | - Null pointer dereference should throw TypeError, not trap (1,604 tests) | high | done |
| #729 | - Class feature codegen gaps (1,161 tests) | high | done |
| #730 | - Missing exception paths: 708 tests expect throws but code runs to completion | high | done |
| #731 | - Function/class .name property (558 tests) | medium | done |
| #732 | - hasOwnProperty correctness (520 tests) | medium | done |
| #734 | - Array method correctness (343 tests) | medium | done |
| #738 | - instanceof correctness (276 tests) | medium | done |
| #740 | - Remove duplicated lib.d.ts copies, read from typescript package at runtime | medium | done |
| #765 | - Compile error triage: 4,443 remaining CEs by pattern | critical | done |
| #771 | - Arguments object incomplete (~617 tests) | high | done |
| #772 | - Insert missing extern.convert_any at call sites (1,299 CE) | critical | done |
| #775 | - Null pointer traps should be catchable TypeError (1,604 tests) | high | done |
| #780 | - TypeError (null/undefined access) in built-in method dispatch (~9,128 tests) | critical | done |
| #781 | - TypeError (null/undefined access) in language constructs (~2,841 tests) | high | done |
| #782 | - Destructuring binding patterns produce wrong values (~3,487 tests) | high | done |
| #783 | - assert.throws failures: missing exception throwing (~3,293 tests) | high | done |
| #784 | - Expected SyntaxError but compiled successfully (~2,657 tests) | medium | done |
| #785 | - Null pointer traps in compiled Wasm code (~1,604 tests) | high | done |
| #787 | - Wrong values in assert.sameValue and other first-assertion failures (~3,517 tests) | high | done |
| #790 | - assert.throws(ReferenceError) not implemented (788 tests) | high | done |
| #791 | - SyntaxError detection gaps: code compiles when it should not | high | done |
| #792 | - emitGuardedRefCast conflates 'wrong type' with 'null' (net-zero from #789) | critical | done |
| #794 | - BindingElement null guard over-triggering in destructuring (537 fail) | high | done |
| #795 | - f64.add on externref — missing unbox coercion (57 CE) | medium | done |
| #796 | - Destructuring initializer not evaluated when value is not undefined (121 fail) | medium | done |
| #797a | #797a -- Per-shape property flags table (compile-time) | critical | done |
| #797b | #797b -- Object.getOwnPropertyDescriptor compile-time resolution | high | done |
| #797d | #797d -- Object.freeze/seal/preventExtensions compile-away | high | done |
| #798 | - try/catch JS exception interop (~3,000 tests) | critical | done |
| #798a | #798a -- Emit catch_all in try/catch compilation | critical | done |
| #798b | #798b -- Catch variable unwrap | high | done |
| #798c | #798c -- Rethrow instruction for throw-of-catch-variable | high | done |
| #799a | #799a -- __proto__ field on structs | high | done |
| #799b | #799b -- Prototype chain walk for property access | critical | done |
| #800 | - Audit: replace runtime emulation with compile-time resolution | medium | done |
| #801 | - Array literal type mismatch in nested destructuring defaults (537 fail) | high | done |
| #812 | - Test262Error 'no dependency provided for extern class' (801 tests) | critical | done |
| #813 | - gen.next is not a function (1,164 tests) | critical | done |
| #814 | - ArrayBuffer 'no dependency provided for extern class' (413 tests) | high | done |
| #875 | Research: ES standard support matrix for all JS-to-Wasm engines | medium | done |
| #928 | Unknown failure tests with empty error message (209 FAIL) | medium | done |
| #973 | Incremental compiler state leak — CompilerPool fork produces ~400 false CEs | high | done |
| #974 | Generate feature table JS/WAT examples from a TypeScript script | medium | done |
| #976 | Extract site nav into reusable web component, share between landing page and dashboard | medium | done |
| #1112 | delete operator via undefined sentinel (232 tests) | medium | done |
| #1114 | propertyHelper.js test262 harness (341 tests) | medium | done |

<!-- GENERATED_ISSUE_TABLES_END -->
