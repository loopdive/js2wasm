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
| 152 | Setter return value error in allowJs mode | — | Ready |
| 242 | Computed property names in class declarations (TS diagnostic) | — | Ready |
| 262 | Argument type assignability — allowJs flexibility | ~325 CE | Done |
| 265 | Computed property names in classes — TS diagnostic | — | Ready (coordinates #242) |
| 269 | Setter return value diagnostic suppression | — | Ready (coordinates #152) |
| 270 | Strict mode reserved words — let, yield, package | — | Ready |
| ~~275~~ | ~~Comma operator warning blocks compilation~~ | ~106 CE | **Done** |
| 276 | Computed property name must be of assignable type | — | Ready (coordinates #242, #265) |

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
| 321 | Collection functions don't scan top-level (__module_init) | **P0** | **Done** |
| 317 | Unused $AnyValue preamble + duplicate export cleanup | **P0** | **Done** |
| 319 | Inline single-use function type signatures | cosmetic | Ready |
| 320 | Dead import and type elimination (umbrella) | — | Blocked by #317 |
| 318 | Infer parameter types from call-site arguments | — | Blocked by #317, #320 |
| 322 | Inline trig/transcendental Math methods as pure Wasm | — | Ready |

---

## Cluster 3: Type coercion / Binary operators `[E]`

```
#138 (valueOf on comparison) ──┐
#139 (valueOf on arithmetic) ──┼──► #300 (object to primitive conversion)
                               │
#227 (BigInt + Infinity) ──────┤
#228 (BigInt == Number) ───────┘
#237 (BigInt i64 vs externref) ─── coordinates with #227, #228

#295 (comparison + type coercion) ── independent
#296 (strict equality -0, NaN) ── independent
#299 (loose equals null/undefined) ── independent
#308 (addition + string/number coercion) ── independent
#301 (float → int saturating trunc) ── independent
```

| #   | Title | Tests | Ready? |
|-----|-------|-------|--------|
| 138 | valueOf/toString coercion on comparison operators | — | Ready |
| 139 | valueOf/toString coercion on arithmetic operators | — | Ready (coordinates #138) |
| 227 | BigInt comparison with Infinity | — | Ready |
| 228 | BigInt equality with Number/Boolean | — | Ready (coordinates #227) |
| 237 | BigInt i64 vs externref type mismatch | — | Ready (coordinates #227, #228) |
| 295 | Comparison operators with type coercion | 8 | **Done** |
| 296 | Strict equality edge cases (-0, NaN) | 4 | Ready |
| 299 | Loose equals edge cases | 2 | Ready |
| 301 | Float unrepresentable in integer range | 4 | Ready |
| 308 | Addition operator + string/number coercion | 7 | Ready |
| 300 | Object to primitive conversion | 5 | Blocked by #138, #139 |

---

## Cluster 4: ClassDeclaration / New expressions `[E][S]`

```
#234 (ClassDecl in nested positions) ──┐
                                       ├──► #260 (ClassDecl + call expression)
#232 (method calls on object literals) ┘
#238 (class expression new) ── independent
#261 (ClassDecl + new for anonymous) ── coordinates with #260
```

| #   | Title | Tests | Ready? |
|-----|-------|-------|--------|
| 234 | ClassDeclaration in nested/expression positions | ~681 CE | Ready |
| 232 | Method calls on object literals | — | Ready |
| 238 | Class expression new — `new (class{})()` | — | Ready |
| 261 | ClassDecl + new expression for anonymous classes | — | Ready (coordinates #260) |
| 260 | ClassDecl + call expression combined | — | Blocked by #234 |

---

## Cluster 5: Property / Element access `[E]`

```
#140 (computed property names runtime) ──► #230 (variable keys in computed props)
#239 (element access on struct types) ── independent
#263 (property does not exist — dynamic) ── independent
#274 (fn.name, fn.length, fn.call, fn.apply) ── independent
#281 (object literal patterns — shorthand, spread) ── independent
#305 (computed property runtime failures) ── coordinates with #140, #230
```

| #   | Title | Tests | Ready? |
|-----|-------|-------|--------|
| 140 | Object computed property names runtime | — | Ready |
| 239 | Element access on struct types (bracket notation) | — | Ready |
| ~~263~~ | ~~Property does not exist on type — dynamic access~~ | — | **Done** |
| 274 | Property access on function type (.name, .length) | — | Ready |
| ~~281~~ | ~~Object literal property patterns~~ | — | **Done** |
| 230 | Object computed property names with variable keys | — | Coordinates with #140 |
| 305 | Computed property names runtime failures | 2 | Coordinates with #140, #230 |

---

## Cluster 6: Assignment / Destructuring `[E]`

```
#142 (assignment destructuring failures) ── independent
#190 (unsupported assignment targets) ── independent
#243 (assignment target patterns — array/object) ── coordinates with #190
#279 (arrow fn params — destructuring/defaults) ── coordinates with #243

#283 (compound assignment — type coercion) ──┐
#286 (logical assignment — nullish/short) ───┼── coordinates (same property/element access)
#306 (prefix/postfix inc/dec on members) ────┘

#294 (assignment evaluation order) ── independent
```

| #   | Title | Tests | Ready? |
|-----|-------|-------|--------|
| 142 | Assignment destructuring failures | — | Ready |
| 190 | Unsupported assignment target patterns | — | Ready |
| 243 | Unsupported assignment target patterns (array/object) | — | Ready (coordinates #190) |
| 279 | Arrow function params — destructuring, defaults | — | Ready (coordinates #243) |
| 283 | Compound assignment — type coercion gaps | — | Ready |
| 286 | Logical assignment — nullish/short-circuit | — | Ready (coordinates #283) |
| 306 | Prefix/postfix increment/decrement | ~44 CE | Ready (coordinates #283) |
| 294 | Assignment expression evaluation order | 7 | Ready |

---

## Cluster 7: Generators / Yield `[S][E]`

```
#241 (yield in strict mode) ──┐
#267 (yield outside generator)┼──► #287 (generator compile errors — yield in loops/try)
                              │     └──► #288 (try/catch in generators)
                              │
#179 (generator module mode) ─┘   (test262-runner wrapping)
```

| #   | Title | Tests | Ready? |
|-----|-------|-------|--------|
| 241 | Yield expression in strict mode / module context | — | Ready |
| 267 | Yield expression outside of generator function | — | Ready |
| 287 | Generator function compile errors — yield in loops/try | ~119 CE | Blocked by #241, #267 |
| 288 | Try/catch/finally compile errors — complex patterns | ~40 CE | Coordinates with #287 |

---

## Cluster 8: Loops / Iteration `[S]`

```
#250 (for-loop with function declarations) ── independent
#292 (for-loop incorrect computed values) ── independent
#268 (iterator protocol / Symbol.iterator) ── independent
#289 (for-in compile errors — property enum) ── independent
#297 (switch fall-through) ── independent
#298 (function statement hoisting in blocks) ── independent
```

| #   | Title | Tests | Ready? |
|-----|-------|-------|--------|
| 250 | For-loop with function declarations | ~113 CE | Ready |
| 292 | For-loop incorrect computed values | 15 | Ready |
| 268 | Iterator protocol — Symbol.iterator | — | Ready |
| 289 | For-in compile errors | ~13 CE | Ready |
| 297 | Switch statement fall-through | 2 | Ready |
| 298 | Function statement edge cases | 2 | Ready |

---

## Cluster 9: Scope / Identifiers `[I][S]`

```
#202 (variable scope and hoisting) ──┐
#146 (unknown identifier errors)  ───┼── all touch scope resolution
#266 (multi-variable destructuring) ─┘
```

| #   | Title | Tests | Ready? |
|-----|-------|-------|--------|
| 202 | Variable scope and hoisting | — | Ready |
| 146 | Unknown identifier / scope issues | ~269 CE | Ready (coordinates #202) |
| 266 | Unknown identifier — multi-variable patterns | — | Ready (coordinates #202) |

---

## Cluster 10: Wasm validation / Type mismatch `[E][I]`

```
#277 (local.set externref vs concrete) ──┐
#178 (LEB128 / large type indices)    ───┼──► #315 (systematic validation audit)
```

| #   | Title | Tests | Ready? |
|-----|-------|-------|--------|
| ~~277~~ | ~~Wasm type mismatch — local.set externref vs concrete~~ | — | **Done** |
| 178 | Wasm validation errors — LEB128, large type indices | — | Ready |
| 315 | Wasm validation error audit — systematic fix | ~93 CE | After #178 recommended (#277 done) |

---

## Cluster 11: Test infrastructure `[T]`

All independent of each other and of codegen work.

| #   | Title | Ready? |
|-----|-------|--------|
| 271 | Cannot find name — missing harness/global declarations | Ready |
| 309 | Expand test262 harness includes | Ready |
| 310 | Reduce skip filters — re-evaluate conservative skips | Ready |
| 311 | Test262 category expansion — String methods | Ready |
| 312 | Test262 category expansion — Number methods | Ready |
| 313 | Test262 category expansion — new expression categories | Ready |
| 314 | Performance — compile time profiling | Ready |

---

## Cluster 12: Standalone / Unclustered

| #   | Title | File | Tests | Ready? |
|-----|-------|------|-------|--------|
| 235 | Function.name property access | [E] | ~380 CE | Ready (partially addressed by #263) |
| 244 | `in` operator runtime failures | [E] | — | Ready |
| 249 | Misc runtime failures — small fixes | [E] | — | Ready |
| 254 | Private class fields and methods (#field) | [E] | — | Ready |
| ~~280~~ | ~~Function expression name binding and hoisting~~ | [E][S] | — | **Done** |
| 290 | instanceof — class hierarchy and expressions | [E] | ~20 CE | Ready |
| 291 | `in` operator compile errors — dynamic property | [E] | ~10 CE | Ready (coordinates #244) |
| 293 | Class method incorrect results | [E] | 10 | Ready |
| 302 | Math.min/max edge cases | [E] | 2 | Ready |
| 303 | parseInt edge cases | [E] | 1 | Ready |
| 304 | Unary minus and return edge cases | [E] | 2 | Ready |
| 307 | Promise.all/race compile errors | [E] | 7 | Ready |
| 316 | Array element access out of bounds | [E] | 1 | Ready |
| 229 | Tagged template cache: array out of bounds | [E] | — | Ready |

---

## Backlog (long-term / blocked)

| #   | Title | Blocked by |
|-----|-------|-----------|
| 130 | Shape inference Phase 4 — hashmap fallback | — (large scope) |
| 147 | Function.name property | — (M complexity) |
| 149 | Unsupported call expression patterns | #232 is Phase 1 |
| 153 | Iterator protocol for destructuring | #268 |
| 173 | Computed property names in classes | #242, #265 |
| 79  | Gradual typing — boxed `any` | — (large scope) |
| 70  | Fast mode Phase 4 — C ABI | — (depends on #46, #33) |
| 74  | WASM SIMD | Blocked by #70 Phase 4 |
| 81  | npm package resolution | Blocked by #80, #28 |
| 123 | Wrapper constructors | Won't implement |
| 124 | delete operator | Won't implement |
| 125 | Object.defineProperty | Won't implement |
| 129 | propertyHelper.js harness | Blocked by #125 |
| 323 | Native type annotations (:i32, :f32, :u8) | Blocked by #70 |
| 322 | Inline trig Math methods | Blocked by #321 |

---

## Quick reference: File contention

When picking parallel work items, avoid pairing issues that touch the same
function in the same file. Key contention points:

| Function | Issues |
|----------|--------|
| `compileBinaryExpression` | 138, 139, 174, 227, 228, 237, 244, 291, 295, 296, 299, 308 |
| `compileCallExpression` | 232, 260, 280 |
| `compileElementAccess` | 140, 176, 239 |
| `compilePropertyAccess` | 263, 274 |
| `compileObjectLiteralForStruct` | 230, 281 |
| `compileDestructuringAssignment` | 142, 190, 243 |
| `compileNewExpression` | 238, 261 |
| `coerceType` | 237, 277, 300, 301, 315 |
| diagnostic suppression (index.ts) | 152, 242, 262, 265, 269, 270, 275, 276 |
| `collectStringLiterals/MathImports` | 321, 320 |
| `registerAnyValueType` | 317, 320 |
| scope resolution | 146, 202, 266 |
| generator codegen | 241, 267, 287, 288 |
