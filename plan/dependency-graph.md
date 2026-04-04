# Issue Dependency Graph

Issues organized by dependency order -- work items at the top are ready now,
items below unlock when their dependencies complete. No sprint batching needed:
pick any "ready" item and start.

## Legend

- **Ready** -- no blockers, can start immediately
- **Blocked by #N** -- requires #N to be done first
- **Coordinates with #N** -- touches same code, should not run in parallel
- File icons show which codegen file is primarily touched:
  `[E]` = expressions.ts, `[S]` = statements.ts, `[I]` = index.ts, `[T]` = test262-runner.ts

---

## TOP PRIORITY: Highest-impact runtime failures `[E][S][I]`

These are the biggest bang-for-buck issues. Pick from here first.

```
#822 (Wasm type mismatch CE -- 907 CE) -- BLOCKED (needs architect, repair-pass approach failed)
~~#826 (illegal cast -- 1,294 FAIL) -- DONE (0 illegal_cast remaining, 255 tests fixed)~~
~~#851 (iterator close protocol -- 147 FAIL) -- DONE (sync paths fixed, break/throw/continue call return())~~
~~#839 (return_call stack/type mismatch -- 158 CE) -- DONE~~
```

### Done (sprint-30)
~~#852~~ ~~#846~~ ~~#848~~ ~~#847~~ ~~#827~~ ~~#825~~ ~~#860~~ ~~#857~~ ~~#850~~ ~~#824~~

| #   | Title | Impact | Status |
|-----|-------|--------|--------|
| **822** | Wasm type mismatch compile errors | **907 CE** | **Blocked** — needs architect (repair passes caused +6K CE regression) |
| ~~**826**~~ | ~~Illegal cast failures (sub of #820)~~ | ~~**~489 FAIL**~~ | **Done** (0 illegal_cast, 255 tests fixed) |
| ~~**851**~~ | ~~Iterator close protocol~~ | ~~**~100 FAIL**~~ | **Done** (sync fixed, break/throw/continue call return()) |
| ~~**839**~~ | ~~return_call stack/type mismatch in constructors~~ | ~~**158 CE**~~ | **Done** |
| ~~**854**~~ | ~~Iterator protocol: null next/return/throw methods~~ | ~~**126 FAIL**~~ | **Done** (sub-issue 4: 32/64 iterable tests fixed) |
| ~~**862**~~ | ~~Empty error message failures~~ | ~~**212 FAIL**~~ | **Done** (generator throw deferral) |
| **865** | Console wrapper for fd_write in JS environments | — | **Ready** (MEDIUM) |
| ~~**866**~~ | ~~Regression: NaN sentinel + ToPrimitive (71 tests)~~ | ~~**71 FAIL**~~ | **Done** |

---

## Umbrella issues (analysis/tracking -- sub-issues above are the actionable work)

| #   | Title | Impact | Notes |
|-----|-------|--------|-------|
| 820 | TypeError / null dereference failures | 6,077 FAIL | Sub-issues: #825, #826, #852, #854 |
| 779 | Assert failures: wrong values | 10,099 FAIL | Sub-issues: #846, #847, #848, #849, #850, #855, #856 |
| 786 | Multi-assertion failures (returned N > 2) | 2,142 FAIL | In-progress |
| 696 | Classify "other fail" runtime errors | 4,649 FAIL | Analysis |

---

## Cluster A: Compiler Correctness -- CE reduction `[E][S][I]`

All independent -- can run in parallel (different codegen paths).

| #   | Title | Impact | Ready? |
|-----|-------|--------|--------|
| 822 | Wasm type mismatch compile errors | **907 CE** | **Ready** |
| ~~839~~ | ~~return_call stack args / type mismatch~~ | ~~**158 CE**~~ | **Done** |
| ~~828~~ | ~~Unexpected undefined AST node in compileExpression~~ | ~~**149 CE**~~ | **Done** (already fixed by prior changes) |
| 829 | Unsupported assignment target compile errors | **141 CE** | **Ready** |
| 845 | Misc CE: object literals, RegExp-on-X, for-in/of edges | **340 CE** | **Ready** |
| 844 | Unsupported new expression for built-in classes | **85 CE** | **Ready** |
| 840 | Array concat/push/splice 0-arg support | **31 CE** | **Ready** |
| 835 | Unknown extern class: Error types | **32 CE** | **Ready** |
| 836 | Tagged templates with non-PropertyAccess tags | **20 CE** | **Ready** |
| 843 | super keyword in object literals and edge cases | **20 CE** | **Ready** |
| 842 | new Array() with non-literal/spread args | **14 CE** | **Ready** |
| 831 | Negative test gaps: expected SyntaxError but compiled | **242 FAIL** | **Ready** |
| 927 | Missing early/parse error detection (umbrella for #831) | **840 FAIL** | **Ready** |
| 926 | Fixture tests not supported in unified mode | **172 CE** | **Ready** |
| 764 | Immutable global assignment error | **240 CE** | **Ready** |
| 736 | SyntaxError detection at compile time | 316 FAIL | **Ready** |

---

## Cluster B: Runtime Semantics -- Wrong values `[E][S]`

```
#849 (mapped arguments) -- independent
#855 (promise/async errors) -- independent
#856 (wrong error type) -- coordinates with #846
#858 (worker/timeout/eval null deref) -- independent
#853 (opaque Wasm objects) -- independent
#737 (undefined edge cases) -- independent
#821 (BindingElement null guard) -- independent
```

| #   | Title | Impact | Ready? |
|-----|-------|--------|--------|
| ~~849~~ | ~~Mapped arguments object sync with named params~~ | ~~**200 FAIL**~~ | **Done** |
| 855 | Promise resolution and async error handling | **210 FAIL** | **Ready** |
| 856 | Expected TypeError but got wrong error type | **136 FAIL** | **Ready** |
| 858 | Worker/timeout exits and eval-code null deref | **182 FAIL** | **Ready** |
| 853 | WebAssembly objects are opaque (for-in/Object.create) | **58 FAIL** | **Ready** |
| 737 | Undefined-handling edge cases | 276 FAIL | **Ready** |
| 778 | Illegal cast errors (ref.cast wrong type) | 135 FAIL | **Ready** |
| 821 | BindingElement null guard over-triggering | 537 FAIL | **Review** |
| 928 | Unknown failure tests with empty error message | **209 FAIL** | **Ready** |
| 929 | Object.defineProperty called on non-object | **53 FAIL** | **Ready** |
| 930 | Not-a-constructor detection for built-in methods | **68 FAIL** | **Ready** |

---

## Cluster C: Built-in Methods `[E]`

| #   | Title | Impact | Ready? |
|-----|-------|--------|--------|
| 733 | RangeError validation in built-ins | 442 FAIL | **Ready** (coordinates #846) |
| 763 | RegExp runtime method gaps | ~400 FAIL | **Ready** |
| 739 | Object.defineProperty correctness | 262 FAIL | **Ready** |
| 841 | Unsupported Math methods (sumPrecise, cosh, sinh, tanh) | **19 CE** | **Ready** |

---

## Cluster D: Iterator / Generator / Async `[E][S]`

```
#766 (Symbol.iterator for custom iterables)
  ├── #851 (iterator close protocol)
  └── #854 (null next/return/throw)

#680 (pure Wasm generators) ──► #762 (generator .next() args, blocked)
#681 (pure Wasm iterators) -- independent

#735 (async iteration) -- blocked by generator work
```

| #   | Title | Impact | Ready? |
|-----|-------|--------|--------|
| 766 | Symbol.iterator protocol for custom iterables | ~500 FAIL | **Ready** |
| 851 | Iterator close protocol not implemented | **147 FAIL** | **Ready** |
| 854 | Iterator protocol: null next/return/throw methods | **126 FAIL** | **Ready** |
| 680 | Pure Wasm generators (state machines) | Eliminates 10 host imports | **Ready** |
| 681 | Pure Wasm iterators (struct-based) | Eliminates 5 host imports | **Ready** |
| 762 | Generator .next() argument handling | ~50 FAIL | Blocked by #680 |
| 735 | Async iteration correctness | 329 FAIL | Blocked |

---

## Cluster E: Property Model / Prototype Chain `[E][I]`

| #   | Title | Impact | Ready? |
|-----|-------|--------|--------|
| 797 | Property descriptor subsystem (Phase 3 remaining) | ~5,000 FAIL | **Ready** (CRITICAL) |
| 799 | Prototype chain (remaining: #802 for dynamic) | ~2,500 FAIL | **Ready** (CRITICAL) |
| 802 | Dynamic prototype support (conditional __proto__) | property-model | **Ready** |
| 678 | Dynamic prototype chain (reverted) | 625 FAIL | **Ready** |

---

## Cluster F: Class Features `[E][S]`

| #   | Title | Impact | Ready? |
|-----|-------|--------|--------|
| 848 | Class computed property / accessor correctness | **1,015 FAIL** | **Ready** |
| 793 | Infinite compilation loop on private methods | 5 hang | **Ready** (coordinates #848) |
| 334 | Private class fields and methods | -- | **Ready** |
| 377 | Getter/setter accessor edge cases | -- | **Ready** |
| 329 | Object.setPrototypeOf support | -- | **Ready** |

---

## Cluster G: Destructuring / Assignment `[E]`

```
#852 (destructuring params -- 1,525 FAIL) -- TOP PRIORITY
#847 (for-of destructuring -- 660 FAIL)
#761 (rest/spread dropped -- ~200 FAIL)
```

| #   | Title | Impact | Ready? |
|-----|-------|--------|--------|
| 852 | Destructuring params: null_deref + illegal_cast | **1,525 FAIL** | **Ready** (CRITICAL) |
| 847 | for-await-of / for-of destructuring wrong values | **660 FAIL** | **Ready** |
| 761 | Rest/spread silently dropped in destructuring | ~200 FAIL | **Ready** |
| 142 | Assignment destructuring failures | -- | **Ready** |
| 328 | OmittedExpression (array holes/elision) | -- | **Ready** |
| 379 | Tuple/destructuring type errors | -- | **Ready** |
| 404 | Compound assignment on unresolvable property type | 88 CE | **Ready** |

---

## Cluster H: Type Inference / Performance `[E][I]`

```
#743 (whole-program type mapper) ──► #744 (monomorphize specialized copies)
#773 (monomorphize with call-site types) -- independent
#745 (tagged union types) -- independent
#684 (any-typed variable inference) -- independent
#685 (interprocedural return type) -- independent
```

| #   | Title | Impact | Ready? |
|-----|-------|--------|--------|
| 743 | Whole-program type mapper | High pass impact | **Ready** (critical) |
| 773 | Monomorphize functions with call-site types | High pass impact | **Ready** (critical) |
| 745 | Tagged union types for WasmGC | Type precision | **Ready** |
| 684 | Any-typed variable inference from usage | Many CE | **Ready** |
| 685 | Interprocedural return type flow | Perf + correctness | **Ready** |
| 686 | Closure capture type preservation | Perf | **Ready** |
| 744 | Monomorphize: specialized function copies | Perf | Blocked by #743 |
| 746 | Hidden class optimization | Perf | Blocked |
| 747 | Escape analysis / stack allocation | Perf | Blocked |

---

## Cluster I: Proposals and Standards `[E]`

All independent -- low priority, can be picked up opportunistically.

| #   | Title | Impact | Ready? |
|-----|-------|--------|--------|
| 661 | Temporal API via polyfill | 1,128 tests | **Ready** |
| 674 | SharedArrayBuffer / Atomics | 493 tests | **Ready** |
| 834 | ES2025 Set methods (union, intersection, etc.) | 216 skip | **Ready** |
| 837 | Map/WeakMap upsert (getOrInsert/getOrInsertComputed) | ~110 skip | **Ready** |
| 838 | BigInt64Array / BigUint64Array typed arrays | 19 skip | **Ready** |
| 830 | DisposableStack extern class missing | **38 CE** | **Ready** |
| 675 | Dynamic import() | 471 tests | **Ready** |

---

## Cluster J: Test Infrastructure `[T]`

| #   | Title | Impact | Ready? |
|-----|-------|--------|--------|
| 824 | Compilation timeouts (10s limit) | **548 CE** | **Ready** |
| 687 | Live-streaming report with run selector | Developer UX | **Ready** |
| 699 | Shared compiler pool for test262 | Perf | **Ready** |
| 700 | Reuse ts.CompilerHost across compilations | 25% speedup | Blocked by #699 |
| 832 | Upgrade to TypeScript 6.x for Unicode 16.0 identifiers | 82 skip | **Ready** |
| 833 | Consider sloppy mode support for legacy octal escapes | 16 skip | **Ready** (low) |

---

## Cluster K: Architecture / Refactoring `[E][S][I]`

Module extraction sub-tasks of #688. All independent, can run in parallel.

| #   | Title | Ready? |
|-----|-------|--------|
| 803 | Extract call dispatch -> calls.ts | **Ready** |
| 804 | Extract new expressions -> new-expression.ts | **Ready** |
| 805 | Extract assignment/destructuring -> assignments.ts | **Ready** |
| 806 | Extract increment/decrement -> unary-update.ts | **Ready** |
| 807 | Extract Date/Math/console -> builtins.ts | **Ready** |
| 808 | Extract string/import infra -> imports.ts | **Ready** |
| 809 | Extract native string helpers -> native-strings.ts | **Ready** |
| 810 | Extract class compilation -> class-codegen.ts | **Ready** |
| 811 | Extract fixup passes -> fixups.ts | **Ready** |
| 741 | Extract string/any helpers from index.ts | **Ready** |
| 788 | Modularize src/ into focused subfolder structure | **Ready** |
| 638 | Reverse typeIdxToStructName map | **Ready** |
| 652 | Compile-time ARC / static lifetime analysis | **Ready** (research) |
| 682 | RegExp Wasm engine for standalone mode | **Ready** |

---

## Cluster L: Platform Support

| #   | Title | Ready? |
|-----|-------|--------|
| 639 | Full Component Model adapter (canonical ABI) | **Ready** |
| 640 | WASI HTTP handler | **Ready** |
| 644 | Integrate report into playground | **Ready** |
| 641 | Shopify Functions template | **Ready** |
| 642 | Deno/Cloudflare loader plugins | **Ready** |

---

## Cluster M: Symbol / Well-known `[E]`

```
#481 (Symbol.iterator) ──┬──► #482 (Symbol.toPrimitive)
                         ├──► #484 (Symbol.species)
                         ├──► #485 (Symbol RegExp protocol)
                         ├──► #486 (Symbol.toStringTag/hasInstance)
                         └──┬─► #487 (user Symbol as property key)
                            |
#483 (Symbol() narrow filter) ──┘
```

| #   | Title | Ready? |
|-----|-------|--------|
| 481 | Symbol.iterator | **Ready** (critical) |
| 483 | Symbol() constructor narrow filter | **Ready** |
| 482 | Symbol.toPrimitive | Blocked by #481 |
| 484 | Symbol.species | Blocked by #481 |
| 485 | Symbol RegExp protocol | Blocked by #481 |
| 486 | Symbol.toStringTag/hasInstance | Blocked by #481 |
| 487 | User Symbol as property key | Blocked by #481, #483 |

---

## Older clusters with remaining active items

### Generators / Yield `[S][E]`

| #   | Title | Tests | Ready? |
|-----|-------|-------|--------|
| 287 | Generator function compile errors -- yield in loops/try | ~119 CE | **Ready** |
| 288 | Try/catch/finally compile errors -- complex patterns | ~40 CE | Coordinates with #287 |

### Property / Element access `[E]`

| #   | Title | Ready? |
|-----|-------|--------|
| 239 | Element access on struct types (bracket notation) | **Ready** |
| 274 | Property access on function type (.name, .length) | **Ready** |

### Scope / Identifiers `[I][S]`

| #   | Title | Ready? |
|-----|-------|--------|
| 146 | Unknown identifier / scope issues | **Ready** |
| 266 | Unknown identifier -- multi-variable patterns | **Ready** |
| 380 | Unknown variable/function in test scope | **Ready** |

### Loops / Iteration `[S]`

| #   | Title | Ready? |
|-----|-------|--------|
| 353 | For-of with generators and custom iterators | **Review** |

### Wasm validation `[E][I]`

| #   | Title | Tests | Ready? |
|-----|-------|-------|--------|
| 401 | Wasm validation errors (call args, struct.new, type mismatch) | 3672 CE | **Ready** |
| 405 | Internal compiler errors -- undefined properties | 64 CE | **Ready** |
| 406 | 'base' is possibly null errors | 81 CE | **Ready** |

### Functions / Closures `[E]`

| #   | Title | Ready? |
|-----|-------|--------|
| 356 | Closure-as-value in assert and array-like objects | **Ready** |
| 368 | Global/arrow `this` reference | **Ready** |
| 382 | Spread argument in super/function calls | **Ready** |

### Built-ins / Runtime `[E]`

| #   | Title | Ready? |
|-----|-------|--------|
| 359 | Object.freeze/seal/preventExtensions | **Ready** |
| 369 | globalThis support | **Ready** |
| 385 | Array method argument count errors | **Ready** |

### Modules / Imports `[I]`

| #   | Title | Ready? |
|-----|-------|--------|
| 332 | Export declaration at top level errors | **Ready** |
| 333 | Dynamic import modifier syntax errors | **Ready** |

---

## Backlog (long-term / blocked)

| #   | Title | Blocked by |
|-----|-------|-----------|
| 130 | Shape inference Phase 4 -- hashmap fallback | large scope |
| 149 | Unsupported call expression patterns | #232 is Phase 1 |
| 153 | Iterator protocol for destructuring | #268 |
| 173 | Computed property names in classes | Ready (#242, #265 done) |
| 79  | Gradual typing -- boxed `any` | large scope |
| 339 | Async function and await support | large scope |
| 340 | Error throwing and try/catch/finally | large scope |
| 343 | Prototype chain support | large scope |
| 351 | Async iteration (for-await-of) | depends on #339 |
| 376 | Decorator syntax support | low priority |

---

## Quick reference: File contention

When picking parallel work items, avoid pairing issues that touch the same
function in the same file.

| Function | Issues |
|----------|--------|
| `compileCallExpression` | 382, 409, 489, 827, 857 |
| `compileNewExpression` | 344, 412, 432, 842, 844 |
| `compileDestructuringAssignment` | 142, 328, 379, 420, 761, 847, 852 |
| `compileAssignment` (compound) | 404, 424, 426, 829 |
| `coerceType` | 411, 431, 444, 448, 822, 839 |
| class codegen | 329, 334, 377, 427, 793, 843, 848 |
| null guard emission | 789, 820, 825, 852 |
| ref.cast / type narrowing | 778, 826 |
| loop codegen | 353, 417, 436, 847, 851 |
| built-in runtime | 359, 369, 385, 421, 733, 840, 841, 846 |
| generator codegen | 287, 288, 415, 422, 439, 680 |
| iterator protocol | 481, 766, 851, 854 |
| scope resolution | 146, 266, 380, 429, 443 |
| template literals | 836 |
| module/import handling | 332, 333, 440 |
| return_call / tail call | 839 |
| AST node handling | 828, 845 |
| promise / async | 735, 855 |
| arguments object | 849 |
| property descriptor | 739, 797, 856 |
| prototype chain | 678, 799, 802 |
| Array methods | 827, 840, 857 |
| diagnostic suppression | 381, 831 |
