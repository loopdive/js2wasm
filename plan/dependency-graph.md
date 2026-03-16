# Issue Dependency Graph

Issues organized by dependency order — work items at the top are ready now,
items below unlock when their dependencies complete. No sprint batching needed:
pick any "ready" item and start.

## Legend

- **Ready** — no blockers, can start immediately
- **Blocked by #N** — requires #N to be done first
- **Coordinates with #N** — touches same code, should not run in parallel
- File icons show which codegen file is primarily touched:
  `[E]` = expressions.ts, `[S]` = statements.ts, `[I]` = index.ts, `[T]` = test262-runner.ts

---

## Cluster 1: Diagnostics / allowJs suppression `[I]`

All independent quick wins — touch only the diagnostic suppression list in `index.ts`.
Can all run in parallel (different diagnostic codes).

| #   | Title | Tests | Ready? |
|-----|-------|-------|--------|
| ~~152~~ | ~~Setter return value error in allowJs mode~~ | — | **Done** |
| ~~242~~ | ~~Computed property names in class declarations (TS diagnostic)~~ | — | **Done** |
| ~~262~~ | ~~Argument type assignability — allowJs flexibility~~ | ~325 CE | **Done** |
| ~~265~~ | ~~Computed property names in classes — TS diagnostic~~ | — | **Done** |
| ~~269~~ | ~~Setter return value diagnostic suppression~~ | — | **Done** |
| ~~270~~ | ~~Strict mode reserved words — let, yield, package~~ | — | **Done** |
| ~~275~~ | ~~Comma operator warning blocks compilation~~ | ~106 CE | **Done** |
| ~~276~~ | ~~Computed property name must be of assignable type~~ | — | **Done** |
| 381 | Nullish coalescing false positives | — | Ready |
| ~~383~~ | ~~Label not allowed / let declaration errors~~ | — | **Done** |

---

## Cluster 2: Dead code / Collection scanning `[I]`

```
#321 (collection functions miss top-level)
 ├──► #320 (dead import/type elimination)
 │     └──► #318 (call-site type inference) [E]
 ├──► #322 (inline trig Math methods) [E]
 └──► #317 (unused $AnyValue + duplicate export)
       └──► #318 (call-site type inference) [E]

#319 (inline single-use type signatures) — independent
```

| #   | Title | Tests | Ready? |
|-----|-------|-------|--------|
| ~~321~~ | ~~Collection functions don't scan top-level (__module_init)~~ | **P0** | **Done** |
| ~~317~~ | ~~Unused $AnyValue preamble + duplicate export cleanup~~ | **P0** | **Done** |
| ~~319~~ | ~~Inline single-use function type signatures~~ | cosmetic | **Done** |
| 320 | Dead import and type elimination (umbrella) | — | Blocked by #317 |
| ~~318~~ | ~~Infer parameter types from call-site arguments~~ | — | **Done** |
| ~~322~~ | ~~Inline trig/transcendental Math methods as pure Wasm~~ | — | **Done** |

---

## Cluster 3: Type coercion / Binary operators `[E]`

```
#138 (valueOf on comparison) ──┐
#139 (valueOf on arithmetic) ──┼──► #300 (object to primitive conversion)
                               │
#227 (BigInt + Infinity) ──────┤
#228 (BigInt == Number) ───────┘
#237 (BigInt i64 vs externref) ─── coordinates with #227, #228

#295 (comparison + type coercion) ── DONE
#296 (strict equality -0, NaN) ── DONE
#299 (loose equals null/undefined) ── DONE
#308 (addition + string/number coercion) ── DONE
#301 (float → int saturating trunc) ── DONE
#324 (runtime test failures) ── DONE
#348 (null/undefined arithmetic) ── DONE
```

| #   | Title | Tests | Ready? |
|-----|-------|-------|--------|
| ~~138~~ | ~~valueOf/toString coercion on comparison operators~~ | — | **Done** |
| 139 | valueOf/toString coercion on arithmetic operators | — | Ready (coordinates #138) |
| ~~227~~ | ~~BigInt comparison with Infinity~~ | — | **Done** |
| ~~228~~ | ~~BigInt equality with Number/Boolean~~ | — | **Done** |
| ~~237~~ | ~~BigInt i64 vs externref type mismatch~~ | — | **Done** |
| ~~295~~ | ~~Comparison operators with type coercion~~ | 8 | **Done** |
| ~~296~~ | ~~Strict equality edge cases (-0, NaN)~~ | 4 | **Done** |
| ~~299~~ | ~~Loose equals edge cases~~ | 7 | **Done** |
| ~~301~~ | ~~Float unrepresentable in integer range~~ | 4 | **Done** |
| ~~308~~ | ~~Addition operator + string/number coercion~~ | 7 | **Done** |
| ~~300~~ | ~~Object to primitive conversion~~ | 5 | **Done** |
| ~~324~~ | ~~Runtime test failures (wrong return values)~~ | 396 fail | **Done** |
| ~~348~~ | ~~Null/undefined arithmetic coercion~~ | — | **Done** |

---

## Cluster 4: ClassDeclaration / New expressions `[E][S]`

```
#234 (ClassDecl in nested positions) ──┐
                                       ├──► #260 (ClassDecl + call expression)
#232 (method calls on object literals) ┘
#238 (class expression new) ── DONE
#261 (ClassDecl + new for anonymous) ── DONE
#330 (ClassExpression in unsupported positions) ── DONE
```

| #   | Title | Tests | Ready? |
|-----|-------|-------|--------|
| ~~234~~ | ~~ClassDeclaration in nested/expression positions~~ | ~681 CE | **Done** |
| ~~232~~ | ~~Method calls on object literals~~ | — | **Done** |
| ~~238~~ | ~~Class expression new — `new (class{})()` ~~ | — | **Done** |
| ~~261~~ | ~~ClassDecl + new expression for anonymous classes~~ | — | **Done** |
| ~~260~~ | ~~ClassDecl + call expression combined~~ | — | **Done** |
| ~~330~~ | ~~ClassExpression in unsupported positions~~ | — | **Done** |
| 329 | Object.setPrototypeOf support | — | Ready |
| 334 | Private class fields and methods | — | Ready |
| ~~375~~ | ~~Unsupported expression: SuperKeyword~~ | — | **Done** |
| 377 | Getter/setter accessor edge cases | — | Ready |

---

## Cluster 5: Property / Element access `[E]`

```
#140 (computed property names runtime) ──► #230 (variable keys in computed props)
#239 (element access on struct types) ── DONE
#263 (property does not exist — dynamic) ── DONE
#274 (fn.name, fn.length, fn.call, fn.apply) ── independent
#281 (object literal patterns — shorthand, spread) ── DONE
#305 (computed property runtime failures) ── coordinates with #140, #230
#326 (array element access out of bounds) ── DONE
#337 (null property access at runtime) ── independent
#361 (runtime `in` operator for property checks) ── independent
#362 (typeof on member expressions) ── independent
#378 (increment/decrement on property/element access) ── DONE
```

| #   | Title | Tests | Ready? |
|-----|-------|-------|--------|
| ~~140~~ | ~~Object computed property names runtime~~ | — | **Done** |
| 239 | Element access on struct types (bracket notation) | — | Ready |
| ~~263~~ | ~~Property does not exist on type — dynamic access~~ | — | **Done** |
| 274 | Property access on function type (.name, .length) | — | Ready |
| ~~281~~ | ~~Object literal property patterns~~ | — | **Done** |
| ~~230~~ | ~~Object computed property names with variable keys~~ | — | **Done** |
| ~~305~~ | ~~Computed property names runtime failures~~ | 2 | **Done** |
| ~~326~~ | ~~Array element access out of bounds~~ | 17 fail | **Done** |
| ~~337~~ | ~~Null property access at runtime~~ | — | **Done** |
| ~~361~~ | ~~Runtime `in` operator for property checks~~ | — | **Done** |
| ~~362~~ | ~~typeof on member expressions~~ | — | **Done** |
| ~~378~~ | ~~Increment/decrement on property/element access~~ | — | **Done** |

---

## Cluster 6: Assignment / Destructuring `[E]`

```
#142 (assignment destructuring failures) ── independent
#190 (unsupported assignment targets) ── DONE
#243 (assignment target patterns — array/object) ── DONE
#279 (arrow fn params — destructuring/defaults) ── DONE
#283 (compound assignment — type coercion) ── DONE
#286 (logical assignment — nullish/short) ── DONE
#306 (prefix/postfix inc/dec on members) ── DONE
#294 (assignment evaluation order) ── DONE
#325 (null pointer dereference at runtime) ── DONE
#328 (OmittedExpression — array holes/elision) ── independent
#379 (tuple/destructuring type errors) ── independent
```

| #   | Title | Tests | Ready? |
|-----|-------|-------|--------|
| 142 | Assignment destructuring failures | — | Ready |
| ~~190~~ | ~~Unsupported assignment target patterns~~ | — | **Done** |
| ~~243~~ | ~~Unsupported assignment target patterns (array/object)~~ | — | **Done** |
| ~~279~~ | ~~Arrow function params — destructuring, defaults~~ | — | **Done** |
| ~~283~~ | ~~Compound assignment — type coercion gaps~~ | — | **Done** |
| ~~286~~ | ~~Logical assignment — nullish/short-circuit~~ | — | **Done** |
| ~~306~~ | ~~Prefix/postfix increment/decrement~~ | ~44 CE | **Done** |
| ~~294~~ | ~~Assignment expression evaluation order~~ | 7 | **Done** |
| ~~325~~ | ~~Null pointer dereference at runtime~~ | 32 fail | **Done** |
| 328 | OmittedExpression (array holes/elision) | — | Ready |
| 379 | Tuple/destructuring type errors | — | Ready |

---

## Cluster 7: Generators / Yield `[S][E]`

```
#241 (yield in strict mode) ── DONE
#267 (yield outside generator) ── DONE
#287 (generator compile errors — yield in loops/try) ── blocked by #267
#288 (try/catch in generators) ── coordinates with #287
```

| #   | Title | Tests | Ready? |
|-----|-------|-------|--------|
| ~~241~~ | ~~Yield expression in strict mode / module context~~ | — | **Done** |
| ~~267~~ | ~~Yield expression outside of generator function~~ | — | **Done** |
| 287 | Generator function compile errors — yield in loops/try | ~119 CE | **Ready** (#267 done) |
| 288 | Try/catch/finally compile errors — complex patterns | ~40 CE | Coordinates with #287 |

---

## Cluster 8: Loops / Iteration `[S]`

```
#250 (for-loop with function declarations) ── DONE
#292 (for-loop incorrect computed values) ── DONE
#268 (iterator protocol / Symbol.iterator) ── DONE (strings only)
#289 (for-in compile errors) ── DONE
#297 (switch fall-through) ── DONE
#298 (function statement hoisting in blocks) ── DONE
#353 (for-of with generators and custom iterators) ── independent
#373 (object as loop condition / falsy value handling) ── independent
```

| #   | Title | Tests | Ready? |
|-----|-------|-------|--------|
| ~~250~~ | ~~For-loop with function declarations~~ | ~113 CE | **Done** |
| ~~292~~ | ~~For-loop incorrect computed values~~ | 15 | **Done** |
| ~~268~~ | ~~Iterator protocol — Symbol.iterator~~ | — | **Done** (strings) |
| ~~289~~ | ~~For-in compile errors~~ | ~13 CE | **Done** |
| ~~297~~ | ~~Switch statement fall-through~~ | 2 | **Done** |
| ~~298~~ | ~~Function statement edge cases~~ | 7 | **Done** |
| 353 | For-of with generators and custom iterators | — | Review |
| ~~373~~ | ~~Object as loop condition / falsy value handling~~ | — | **Done** |

---

## Cluster 9: Scope / Identifiers `[I][S]`

```
#202 (variable scope and hoisting) ── DONE
#146 (unknown identifier errors) ── coordinates with #202
#266 (multi-variable destructuring) ── coordinates with #202
#331 (strict mode arguments/eval restriction) ── independent
#380 (unknown variable/function in test scope) ── independent
```

| #   | Title | Tests | Ready? |
|-----|-------|-------|--------|
| ~~202~~ | ~~Variable scope and hoisting~~ | — | **Done** |
| 146 | Unknown identifier / scope issues | ~269 CE | Ready (coordinates #202) |
| 266 | Unknown identifier — multi-variable patterns | — | Ready (coordinates #202) |
| ~~331~~ | ~~Strict mode arguments/eval identifier restriction~~ | — | **Done** |
| 380 | Unknown variable/function in test scope | — | Ready |

---

## Cluster 10: Wasm validation / Type mismatch `[E][I]`

```
#277 (local.set externref vs concrete) ── DONE
#178 (LEB128 / large type indices) ── DONE
#315 (systematic validation audit) ── ready
```

| #   | Title | Tests | Ready? |
|-----|-------|-------|--------|
| ~~277~~ | ~~Wasm type mismatch — local.set externref vs concrete~~ | — | **Done** |
| ~~178~~ | ~~Wasm validation errors — LEB128, large type indices~~ | — | **Done** |
| 315 | Wasm validation error audit — systematic fix | ~93 CE | Ready (#277, #178 done) |

---

## Cluster 11: Test infrastructure `[T]`

All independent of each other and of codegen work.

| #   | Title | Ready? |
|-----|-------|--------|
| 271 | Cannot find name — missing harness/global declarations | Ready |
| ~~309~~ | ~~Expand test262 harness includes~~ | **Done** |
| 310 | Reduce skip filters — re-evaluate conservative skips | Ready |
| ~~311~~ | ~~Test262 category expansion — String methods~~ | **Done** |
| 312 | Test262 category expansion — Number methods | Ready |
| ~~313~~ | ~~Test262 category expansion — new expression categories~~ | **Done** |
| 314 | Performance — compile time profiling | Ready |
| ~~338~~ | ~~Negative test support in test262 runner~~ | — | **Done** |
| ~~360~~ | ~~JSON.stringify result comparison~~ | — | **Done** |

---

## Cluster 12: Built-ins / Runtime `[E]`

Runtime built-in methods and global functions.

| #   | Title | Tests | Ready? |
|-----|-------|-------|--------|
| ~~342~~ | ~~Array.prototype.method.call/apply patterns~~ | — | **Done** |
| ~~344~~ | ~~Wrapper constructors (new Number, new String, new Boolean)~~ | — | **Done** |
| ~~347~~ | ~~Function/class .name property completion~~ | — | **Done** |
| ~~349~~ | ~~String() constructor as function~~ | — | **Done** |
| ~~355~~ | ~~Object.keys/values/entries completion~~ | — | **Done** |
| 359 | Object mutability methods (Object.freeze/seal/preventExtensions) | — | Ready |
| 369 | globalThis support | — | Ready |
| ~~384~~ | ~~replaceAll and other missing string methods~~ | — | **Done** |
| 385 | Array method argument count errors | — | Ready |

---

## Cluster 13: Functions / Closures `[E]`

Function calling patterns, closures, and `this` binding.

| #   | Title | Tests | Ready? |
|-----|-------|-------|--------|
| 356 | Closure-as-value in assert and array-like objects | — | Ready |
| ~~364~~ | ~~call/apply on arrow functions~~ | — | **Done** |
| 368 | Global/arrow `this` reference | — | Ready |
| 382 | Spread argument in super/function calls | — | Ready |

---

## Cluster 14: String / Template literals `[E]`

String operations and tagged template patterns.

| #   | Title | Tests | Ready? |
|-----|-------|-------|--------|
| ~~357~~ | ~~IIFE tagged templates~~ | — | **Done** |
| ~~363~~ | ~~Tagged template .raw property and identity~~ | — | **Done** |
| 367 | String variable concatenation in comparisons | — | Ready |
| 372 | String.prototype.matchAll | — | Review |

---

## Cluster 15: Modules / Imports `[I]`

Module system and import/export patterns.

| #   | Title | Tests | Ready? |
|-----|-------|-------|--------|
| 332 | Export declaration at top level errors | — | Ready |
| 333 | Dynamic import modifier syntax errors | — | Ready |
| ~~371~~ | ~~import.meta support~~ | — | **Done** |

---

## Cluster 16: Standalone / Unclustered

| #   | Title | File | Tests | Ready? |
|-----|-------|------|-------|--------|
| 235 | Function.name property access | [E] | ~380 CE | Ready (partially addressed by #263) |
| 244 | `in` operator runtime failures | [E] | — | Ready |
| ~~254~~ | ~~Private class fields and methods (#field)~~ | [E] | — | **Done** |
| ~~249~~ | ~~Misc runtime failures — small fixes~~ | [E] | — | **Done** |
| ~~280~~ | ~~Function expression name binding and hoisting~~ | [E][S] | — | **Done** |
| ~~290~~ | ~~instanceof — class hierarchy and expressions~~ | [E] | ~20 CE | **Done** |
| ~~291~~ | ~~`in` operator compile errors — dynamic property~~ | [E] | ~10 CE | **Done** |
| ~~293~~ | ~~Class method incorrect results~~ | [E] | 10 | **Done** |
| ~~302~~ | ~~Math.min/max edge cases~~ | [E] | 2 | **Done** |
| ~~303~~ | ~~parseInt edge cases~~ | [E] | 1 | **Done** |
| ~~304~~ | ~~Unary minus and return edge cases~~ | [E] | 2 | **Done** |
| ~~307~~ | ~~Promise.all/race compile errors~~ | [E] | 7 | **Done** |
| ~~316~~ | ~~Array element access out of bounds~~ | [E] | 1 | **Done** |
| ~~229~~ | ~~Tagged template cache: array out of bounds~~ | [E] | — | **Done** |
| ~~327~~ | ~~Object-to-primitive coercion (valueOf/toString)~~ | [E] | — | **Done** |
| ~~335~~ | ~~Parser comma errors (non-computed-property contexts)~~ | [E] | — | **Done** |
| ~~336~~ | ~~For-of assignment destructuring on non-struct refs~~ | [S] | — | **Done** |
| ~~341~~ | ~~Property introspection (hasOwnProperty, propertyIsEnumerable)~~ | [E] | — | **Done** |
| ~~386~~ | ~~Remaining small CE patterns~~ | [E] | — | **Done** |
| 374 | Miscellaneous small patterns | [E] | — | Ready |

---

## Backlog (long-term / blocked)

| #   | Title | Blocked by |
|-----|-------|-----------|
| 130 | Shape inference Phase 4 — hashmap fallback | — (large scope) |
| 147 | Function.name property | — (M complexity) |
| 149 | Unsupported call expression patterns | #232 is Phase 1 |
| 153 | Iterator protocol for destructuring | #268 |
| 173 | Computed property names in classes | Ready (#242, #265 done) |
| 79  | Gradual typing — boxed `any` | — (large scope) |
| 70  | Fast mode Phase 4 — C ABI | — (depends on #46, #33) |
| 74  | WASM SIMD | Blocked by #70 Phase 4 |
| 81  | npm package resolution | Blocked by #80, #28 |
| 123 | Wrapper constructors | Won't implement |
| 124 | delete operator | Won't implement |
| 125 | Object.defineProperty | Won't implement |
| 129 | propertyHelper.js harness | Blocked by #125 |
| 323 | Native type annotations (:i32, :f32, :u8) | Blocked by #70 |
| ~~322~~ | ~~Inline trig Math methods~~ | **Done** |
| 339 | Async function and await support | — (large scope) |
| 340 | Error throwing and try/catch/finally | — (high priority, large scope) |
| 343 | Prototype chain support | — (large scope) |
| 345 | Symbol.iterator and iterable protocol | — (large scope) |
| 346 | Object.defineProperty support | — (large scope) |
| 350 | Symbol type (general) | — (large scope) |
| 351 | Async iteration (for-await-of) | — (depends on #339) |
| 352 | Delete operator | — (low priority) |
| 354 | Reflect.construct | — (low priority) |
| 358 | Dynamic import support | — (low priority) |
| 365 | Collection mutation during for-of | — (low priority) |
| 366 | Object.create support | — (low priority) |
| 370 | WeakMap and WeakSet | — (low priority) |
| 376 | Decorator syntax support | — (low priority) |

---

## Quick reference: File contention

When picking parallel work items, avoid pairing issues that touch the same
function in the same file. Key contention points:

| Function | Issues |
|----------|--------|
| `compileBinaryExpression` | 138, 139, 174, 227, 228, 237, 244, 291, 295, 296, 299, 308, 324, 348 |
| `compileCallExpression` | 232, 260, 280, 342, 364, 382 |
| `compileElementAccess` | 140, 176, 239, 326, 337, 361 |
| `compilePropertyAccess` | 263, 274, 347, 362, 378 |
| `compileObjectLiteralForStruct` | 230, 281 |
| `compileDestructuringAssignment` | 142, 190, 243, 325, 328, 379 |
| `compileNewExpression` | 238, 261, 344 |
| `coerceType` | 237, 277, 300, 301, 315, 348 |
| diagnostic suppression (index.ts) | 152, 242, 262, 265, 269, 270, 275, 276, 381, 383 |
| `collectStringLiterals/MathImports` | 321, 320 |
| `registerAnyValueType` | 317, 320 |
| scope resolution | 146, 202, 266, 331, 380 |
| generator codegen | 241, 267, 287, 288 |
| string methods | 349, 367, 372, 384 |
| template literals | 357, 363 |
| module/import handling | 332, 333, 371 |
| class codegen | 329, 334, 375, 377 |
| loop codegen | 353, 373 |
| built-in runtime | 344, 355, 359, 369, 385 |
