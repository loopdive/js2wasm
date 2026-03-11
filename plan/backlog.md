# ts2wasm Backlog

## Sprint 1 (done)

_Goal: Eliminate all 146 test262 runtime failures and reduce compile errors by ~700._
_Details: [sprint-1.md](sprint-1.md)_
_Result: 550 to 1,509 passing tests (+174%), 86/86 equivalence tests green._

| #   | Feature | Status |
| --- | ------- | ------ |
| [138](issues/138.md) | Bug: valueOf/toString coercion on comparison operators | Done |
| [139](issues/139.md) | Bug: valueOf/toString coercion on arithmetic operators | Done |
| [140](issues/140.md) | Bug: object computed property names runtime | Partial |
| [141](issues/141.md) | Bug: tagged template literal runtime failures | Partial |
| [142](issues/142.md) | Bug: assignment destructuring failures | Partial |
| [143](issues/143.md) | Bug: for-loop edge cases | Done |
| [144](issues/144.md) | Bug: new expression with class expressions | Done |
| [145](issues/145.md) | allowJs type flexibility: boolean/string/void as number | Done |
| [148](issues/148.md) | Element access (bracket notation) on struct types | Done |
| [150](issues/150.md) | ClassDeclaration in expression positions | Done |
| [151](issues/151.md) | `this` keyword in class methods for test262 | Reverted |
| [152](issues/152.md) | Setter return value error in allowJs mode | Done |
| [154](issues/154.md) | Bug: while/do-while loop condition evaluation | Done |
| [155](issues/155.md) | Bug: logical-and/logical-or short-circuit | Done |
| [156](issues/156.md) | Bug: conditional (ternary) expression evaluation | Done |
| [157](issues/157.md) | Bug: void expression returns wrong value | Done |
| [158](issues/158.md) | Bug: concatenation with non-string operands | Done |
| [159](issues/159.md) | Bug: call expression edge cases | Done |
| [160](issues/160.md) | Bug: Math method edge cases | Done |
| [161](issues/161.md) | Bug: compound assignment edge cases | Done |
| [162](issues/162.md) | Bug: switch statement matching | Done |
| [163](issues/163.md) | Bug: return statement edge cases | Done |
| [164](issues/164.md) | Bug: variable declaration edge cases | Done |
| [165](issues/165.md) | Bug: function statement hoisting and edge cases | Done |
| [166](issues/166.md) | Bug: `in` operator runtime failures | Done |
| [167](issues/167.md) | Bug: typeof edge cases | Done |
| [168](issues/168.md) | Bug: equality operators with null/undefined | Done |
| [169](issues/169.md) | Bug: arrow function edge case | Done |
| [170](issues/170.md) | Bug: class expression/declaration edge cases | Done |
| [171](issues/171.md) | Bug: Boolean() edge cases | Done |
| [172](issues/172.md) | Bug: Array.isArray edge case | Done |

## Sprint 2 (current)

_Goal: Fix all 167 runtime failures (100% compilable pass rate) and reduce compile errors by ~500._
_Details: [sprint-2.md](sprint-2.md)_

| #   | Feature | Status | Assignee |
| --- | ------- | ------ | -------- |
| [214](issues/214.md) | Bug: unicode escape in member-expr-ident-name (44 fails) | Open | -- |
| [208](issues/208.md) | Bug: comparison operators valueOf + BigInt (24 fails) | Open | -- |
| [212](issues/212.md) | Bug: object computed property name expressions (15 fails) | Open | -- |
| [207](issues/207.md) | Bug: class statement/expression runtime failures (14 fails) | Open | -- |
| [209](issues/209.md) | Bug: for-loop label/function edge cases (8 fails) | Open | -- |
| [210](issues/210.md) | Bug: for-of destructuring runtime failures (7 fails) | Open | -- |
| [211](issues/211.md) | Bug: function statement runtime failures (7 fails) | Open | -- |
| [177](issues/177.md) | Bug: spread operator in new expressions (6 fails) | Open | -- |
| [141](issues/141.md) | Bug: tagged template literal failures (carryover, 6 fails) | Open | -- |
| [175](issues/175.md) | Bug: negative zero not preserved in arithmetic (3 fails) | Open | -- |
| [213](issues/213.md) | Bug: while/do-while loop condition edge cases (4 fails) | Open | -- |
| [185](issues/185.md) | Bug: unary plus on non-numeric types (2 fails) | Open | -- |
| [186](issues/186.md) | Bug: typeof null returns wrong value (2 fails) | Open | -- |
| [203](issues/203.md) | LEB128 encoding overflow for large type indices (~20 CE) | Open | -- |
| [184](issues/184.md) | Function arity mismatch: missing argument padding (~15 CE) | Open | -- |
| [180](issues/180.md) | JS var re-declaration type mismatch (~26 CE) | Open | -- |
| [190](issues/190.md) | Unsupported assignment target patterns (~136 CE) | Open | -- |
| [195](issues/195.md) | Prefix/postfix increment on property access (~44 CE) | Open | -- |
| [182](issues/182.md) | Arrow function closure type coercion (~12 CE) | Open | -- |
| [196](issues/196.md) | Try/catch/finally: catch variable typing (~40 CE) | Open | -- |
| [183](issues/183.md) | Template literal type coercion wasm errors (~6 CE) | Open | -- |
| [193](issues/193.md) | Coalesce operator wasm type mismatch (~7 CE) | Open | -- |
| [200](issues/200.md) | JSON.parse/stringify compile errors (~24 CE) | Open | -- |
| [205](issues/205.md) | String.prototype.indexOf type coercion (~5 CE) | Open | -- |
| [181](issues/181.md) | new Object() constructor support (~39 CE) | Open | -- |
| [187](issues/187.md) | String prototype methods: refine skip filter (~400 unlocked) | Open | -- |
| [191](issues/191.md) | assert not found: fix test wrapper (~40 CE) | Open | -- |
| [140](issues/140.md) | Bug: object computed property names (carryover) | Open | -- |
| [142](issues/142.md) | Bug: assignment destructuring (carryover) | Open | -- |
| [197](issues/197.md) | Statement-level if compile errors (~6 CE) | Open | -- |

## Recently completed

| #   | Feature | Status |
| --- | ------- | ------ |
| [214](issues/214.md) | Fix: string relational operators (<, >, <=, >=) | Review |
| [215](issues/215.md) | Fix: unary plus coercion for strings/booleans | Review |
| [216](issues/216.md) | Fix: modulus with special IEEE 754 values | Review |

## Backlog

### Property names and computed keys

| #                    | Feature                                            | Complexity | Tests blocked |
| -------------------- | -------------------------------------------------- | ---------- | ------------- |
| [207](issues/207.md) | Unicode escape sequences in property names         | S          | ~42           |
| [208](issues/208.md) | Computed property names with complex expressions   | S          | ~15           |

### Core language features

| #                    | Feature                                            | Complexity | Tests blocked |
| -------------------- | -------------------------------------------------- | ---------- | ------------- |
| [130](issues/130.md) | Shape inference Phase 4 -- hashmap fallback + more methods | L   | 2,200+        |
| [146](issues/146.md) | Unknown identifier / scope issues | L | ~932 |
| [147](issues/147.md) | Function.name property | M | ~258 |
| [149](issues/149.md) | Unsupported call expression patterns | L | ~2,675 |
| [153](issues/153.md) | Iterator protocol for destructuring | M | ~67 |
| [173](issues/173.md) | Computed property names in classes | M | ~132 |
| [176](issues/176.md) | Unicode escape in property names (broader) | S | ~42 |
| [178](issues/178.md) | Wasm validation errors: type mismatches | L | ~170 |
| [179](issues/179.md) | Generator yield in module mode | M | ~56 |
| [188](issues/188.md) | instanceof compile errors | M | ~20 |
| [189](issues/189.md) | new.target meta-property | M | ~7 |
| [192](issues/192.md) | Computed property names CE (object + class) | M | ~68 |
| [194](issues/194.md) | Logical assignment CE | M | ~34 |
| [198](issues/198.md) | Switch statement CE | S | ~5 |
| [199](issues/199.md) | Labeled statements CE | S | ~5 |
| [201](issues/201.md) | Object.keys/values/entries CE | M | ~24 |
| [202](issues/202.md) | Variable scope/hoisting CE | L | ~150 |
| [204](issues/204.md) | Array literal CE | M | ~15 |
| [206](issues/206.md) | For-loop with function declarations CE | L | ~113 |
| [174](issues/174.md) | BigInt cross-type comparison | M | ~15 |

### Won't implement (fundamental JS runtime features)

| #                    | Feature                                            | Reason                    |
| -------------------- | -------------------------------------------------- | ------------------------- |
| [123](issues/123.md) | Wrapper constructors (new Number/String/Boolean)   | JS legacy, TS discourages |
| [124](issues/124.md) | delete operator                                    | Fixed struct fields       |
| [125](issues/125.md) | Object.defineProperty / property descriptors       | Runtime metaprogramming   |
| [129](issues/129.md) | propertyHelper.js harness                          | Depends on #125           |



## Complexity legend

- XS: < 50 lines, one file
- S: < 150 lines, 1-2 files
- M: < 400 lines, 2-3 files
- L: > 400 lines, multiple files

## Completed


| #                           | Feature                                                 | Tests                                   |
| --------------------------- | ------------------------------------------------------- | --------------------------------------- |
| [1](issues/done/1.md)       | do-while loops                                          | 2 in control-flow.test.ts               |
| [2](issues/done/2.md)       | switch statements                                       | 3 in control-flow.test.ts               |
| [3](issues/done/3.md)       | Arrays                                                  | 5 in arrays-enums.test.ts               |
| [4](issues/done/4.md)       | for-of loops                                            | 2 in control-flow.test.ts               |
| [5](issues/done/5.md)       | Enums                                                   | 4 in arrays-enums.test.ts               |
| [6](issues/done/6.md)       | Classes                                                 | in codegen (needs test file)            |
| [7](issues/done/7.md)       | Closures / arrow functions                              | in codegen (needs test file)            |
| [8](issues/done/8.md)       | Generics                                                | 5 in generics.test.ts                   |
| [9](issues/done/9.md)       | for-in loops                                            | --                                      |
| [10](issues/done/10.md)     | DOM support                                             | --                                      |
| [11](issues/done/11.md)     | Arrow function callbacks                                | --                                      |
| [12](issues/done/12.md)     | VS Code-like IDE layout for playground                  | --                                      |
| [13](issues/done/13.md)     | Template literals (substitutions)                       | --                                      |
| [14](issues/done/14.md)     | String methods                                          | --                                      |
| [15](issues/done/15.md)     | Ternary / conditional expression                        | --                                      |
| [16](issues/done/16.md)     | Optional chaining and nullish coalescing                | --                                      |
| [17](issues/done/17.md)     | Destructuring                                           | --                                      |
| [18](issues/done/18.md)     | Spread and rest operators                               | 13 in spread-rest.test.ts               |
| [19](issues/done/19.md)     | Type narrowing and union types                          | 4 in union-narrowing.test.ts            |
| [20](issues/done/20.md)     | Async/await and Promises (early spec)                   | superseded by #30                       |
| [21](issues/done/21.md)     | Array methods (early spec)                              | superseded by #26                       |
| [22](issues/done/22.md)     | Multi-file modules (early spec)                         | superseded by #28                       |
| [23](issues/done/23.md)     | Bitwise operators                                       | 14 in bitwise.test.ts                   |
| [24](issues/done/24.md)     | Exponentiation operator                                 | 1 in equivalence.test.ts                |
| [25](issues/done/25.md)     | Fix f32.const opcode in binary emitter                  | --                                      |
| [26](issues/done/26.md)     | Array methods via host imports                          | 22 in array-methods.test.ts             |
| [27](issues/done/27.md)     | Try/catch/throw                                         | 8 in try-catch.test.ts                  |
| [28](issues/done/28.md)     | Multi-file module compilation                           | 10 in multi-file.test.ts                |
| [29](issues/done/29.md)     | Investigate failing tests                               | fixed 2 in import-resolver              |
| [30](issues/done/30.md)     | Async/await and Promises                                | 8 in async-await.test.ts                |
| [31](issues/done/31.md)     | Default number type to i32 (via fast mode)              | 13 in i32-fast-mode.test.ts             |
| [32](issues/done/32.md)     | Capacity-based arrays with `array.copy`                 | 4 in array-capacity.test.ts             |
| [33](issues/done/33.md)     | Relocatable Wasm object file (.o) emission              | in linker-e2e.test.ts                   |
| [34](issues/done/34.md)     | Multi-memory module linker                              | in linker-e2e.test.ts                   |
| [35](issues/done/35.md)     | Class inheritance with extends and super                | 7 in inheritance.test.ts                |
| [36](issues/done/36.md)     | Static class members                                    | 8 in static-members.test.ts             |
| [37](issues/done/37.md)     | Getter/setter properties                                | 6 in getters-setters.test.ts            |
| [38](issues/done/38.md)     | Implement `instanceof` operator                         | 4 in instanceof.test.ts                 |
| [39](issues/done/39.md)     | Labeled break and continue                              | 7 in labeled-loops.test.ts              |
| [40](issues/done/40.md)     | String enums                                            | 5 in string-enums.test.ts               |
| [41](issues/done/41.md)     | typeof as expression                                    | 5 in typeof-expression.test.ts          |
| [42](issues/done/42.md)     | Comma operator                                          | 5 in comma-operator.test.ts             |
| [43](issues/done/43.md)     | void expression                                         | 3 in void-expr.test.ts                  |
| [44](issues/done/44.md)     | Source map generation                                   | 18 in sourcemap.test.ts                 |
| [45](issues/done/45.md)     | Error reporting with source locations                   | 7 in error-reporting.test.ts            |
| [46](issues/done/46.md)     | Linear-memory compilation backend                       | 3 in linker-e2e.test.ts                 |
| [47](issues/done/47.md)     | importedStringConstants support                         | 21 in imported-string-constants.test.ts |
| [48](issues/done/48.md)     | Cache string literals in locals                         | 9 in string-literal-cache.test.ts       |
| [49](issues/done/49.md)     | Default parameter values                                | 8 in default-params.test.ts             |
| [50](issues/done/50.md)     | Nullish/logical assignment                              | 11 in logical-assignment.test.ts        |
| [51](issues/done/51.md)     | Functional array methods                                | 24 in functional-array-methods.test.ts  |
| [52](issues/done/52.md)     | String.split()                                          | 5 in string-split.test.ts               |
| [53](issues/done/53.md)     | Numeric separators                                      | 6 in numeric-separators.test.ts         |
| [54](issues/done/54.md)     | Map and Set collections                                 | 19 in map-set.test.ts                   |
| [55](issues/done/55.md)     | Function expressions                                    | 5 in function-expressions.test.ts       |
| [56](issues/done/56.md)     | Tuples                                                  | 10 in tuples.test.ts                    |
| [57](issues/done/57.md)     | Class expressions                                       | 3 in class-expressions.test.ts          |
| [58](issues/done/58.md)     | Iterators and for...of                                  | 6 in iterators.test.ts                  |
| [59](issues/done/59.md)     | Abstract classes                                        | 6 in abstract-classes.test.ts           |
| [60](issues/done/60.md)     | RegExp via host imports                                 | in regexp.test.ts                       |
| [61](issues/done/61.md)     | Object.keys / Object.values / Object.entries            | 13 in object-methods.test.ts            |
| [62](issues/done/62.md)     | JSON.parse / JSON.stringify                             | 5 in json.test.ts                       |
| [63](issues/done/63.md)     | Promise.all / Promise.race                              | 4 in promise-combinators.test.ts        |
| [64](issues/done/64.md)     | Generators and yield                                    | 9 in generators.test.ts                 |
| [65](issues/done/65.md)     | Computed property names                                 | 6 in computed-props.test.ts             |
| [66](issues/done/66.md)     | Security design doc -- runtime import hardening         | --                                      |
| [67](issues/done/67.md)     | Closed import objects                                   | in closed-imports.test.ts               |
| [68](issues/done/68.md)     | DOM containment                                         | in dom-containment.test.ts              |
| [69](issues/done/69.md)     | Safe mode -- compile-time security checks               | 14 in safe-mode.test.ts                 |
| [70 Ph1](issues/done/31.md) | Fast mode Phase 1 -- i32 default numbers                | 13 in i32-fast-mode.test.ts             |
| [71](issues/done/71.md)     | Fast mode Phase 2 -- WasmGC-native strings              | in native-strings.test.ts               |
| [72](issues/done/72.md)     | Fast mode Phase 3 -- WasmGC-native arrays               | in native-arrays.test.ts                |
| [73](issues/done/73.md)     | Benchmark -- JS vs host-call vs GC-native vs linear     | benchmark suite                         |
| [75](issues/done/75.md)     | Slice-based string views for substring/trim/slice       | in native-strings.test.ts               |
| [76](issues/done/76.md)     | Rope/cons-string for O(1) concatenation                 | in native-strings.test.ts               |
| [77](issues/done/77.md)     | Object literals, spread, structural typing              | in object-literals.test.ts              |
| [78](issues/done/78.md)     | Standard library coverage -- builtins and static methods | in stdlib.test.ts                      |
| [80](issues/done/80.md)     | JS file compilation via `.d.ts` types                   | in js-compilation.test.ts               |
| [82](issues/done/82.md)     | Study V8, SpiderMonkey, Zena, AssemblyScript strategies | findings doc                            |
| [83](issues/done/83.md)     | Test262 conformance suite -- Phase 1+2                  | in test262.test.ts                      |
| [84](issues/done/84.md)     | `var` hoisting support                                  | 5 in var-hoisting.test.ts               |
| [85](issues/done/85.md)     | Variadic `Math.min` / `Math.max`                        | in stdlib.test.ts                       |
| [86](issues/done/86.md)     | `new Array()` constructor expression                    | in array-methods.test.ts                |
| [88](issues/done/88.md)     | Test262 -- language/expressions                         | 412 pass, 0 fail (6773 total)           |
| [89](issues/done/89.md)     | Test262 -- language/statements                          | test262 stmt categories                 |
| [90](issues/done/90.md)     | Test262 -- built-ins/Array                              | 20 Array prototype categories           |
| [91](issues/done/91.md)     | Test262 -- built-ins/Number                             | EPSILON, MAX/MIN_SAFE_INTEGER           |
| [92](issues/done/92.md)     | Test262 -- language/types (coercion)                    | all type categories pass                |
| [93](issues/done/93.md)     | Test262 -- built-ins/Object                             | keys/values/entries categories          |
| [94](issues/done/94.md)     | Test262 -- language/function-code                       | statements/function category            |
| [95](issues/done/95.md)     | Test262 -- built-ins/isNaN + isFinite                   | already present, all pass               |
| [96](issues/done/96.md)     | Test262 -- built-ins/JSON                               | JSON.parse 12/12, stringify skipped     |
| [97](issues/done/97.md)     | NaN/undefined/null truthiness fix                       | test262 + test_debug                    |
| [98](issues/done/98.md)     | ToInt32 for bitwise compound assignments                | test262 bitwise tests                   |
| [99](issues/done/99.md)     | Externref arithmetic/comparison/control                 | test262: 82% to 100% compilable         |
| [100](issues/done/100.md)  | Mutable closure captures via ref cells                  | ref cell boxing codegen                 |
| [104](issues/done/104.md)  | Test262 -- language/ top-level categories               | destructuring, rest, computed-props     |
| [108](issues/done/108.md)  | String(), Boolean(), Array() as conversion functions    | in equivalence tests                    |
| [110](issues/done/110.md)  | `in` operator for property existence test               | compile-time struct check               |
| [111](issues/done/111.md)  | ES2015+ Math methods (hypot, acosh, fround, ...)        | inline + host imports                   |
| [112](issues/done/112.md)  | Number static methods (isSafeInteger, parseFloat, ...)  | inline + delegation                     |
| [113](issues/done/113.md)  | Bug -- "Object literal type not mapped to struct"       | inferred type fallback                  |
| [114](issues/done/114.md)  | Bug -- "vec data field not ref" array codegen crash     | accept ref_null data fields             |
| [70 Ph4](issues/70.md)    | Fast mode Phase 4 -- C ABI for multi-language linking   | c-abi.test.ts (38 tests)                |
| [79](issues/79.md)        | Gradual typing -- boxed `any` with runtime dispatch     | 37 in equivalence.test.ts               |
| [81](issues/81.md)        | npm package resolution and tree-shaking                 | 18 in resolve.test.ts                   |
| [74](issues/74.md)        | WASM SIMD for string and array operations               | simd.test.ts + benchmarks               |
| [109](issues/done/109.md) | Tagged template literals                                | runtime + codegen                       |
| [115](issues/done/115.md)  | Bug -- var hoisting in function scope                   | pre-pass walkStmtForVars                |
| [87](issues/done/87.md)   | Math.round negative zero preservation                   | inline wasm, -0 via copysign            |
| [101](issues/done/101.md) | Test262 -- language/statements                          | for-of, for-in, class, generators, async|
| [102](issues/done/102.md) | Test262 -- language/expressions                         | 22 expression categories                |
| [103](issues/done/103.md) | Test262 -- built-ins/String/prototype                   | 21 String method categories             |
| [105](issues/done/105.md) | Test262 -- Map/Set/Promise                              | 16 collection/promise categories        |
| [106](issues/done/106.md) | Test262 -- Object/Array extended                        | Array.isArray + skip filters            |
| [107](issues/done/107.md) | Fix codegen null-dereference crashes                    | try-catch + null guards                 |
| [116](issues/116.md)      | Unskip implemented features in test262 runner           | 26 features unskipped, +13 passing      |
| [117](issues/117.md)      | String comparison in test262 harness                    | assert_sameValue_str                    |
| [118](issues/118.md)      | compareArray.js test262 harness shim                    | compareArray shim                       |
| [130 Ph1-3](issues/130.md)| Shape inference + call/apply inlining                   | 4 in equivalence.test.ts                |
| [119](issues/119.md)      | assert.throws support in test262 harness                | removeAssertThrows()                    |
| [120](issues/120.md)      | undefined/void 0 comparison support                     | stripUndefinedThrowGuards()             |
| [122](issues/122.md)      | arguments object                                        | vec struct from params                  |
| [126](issues/126.md)      | valueOf/toString coercion                               | class method dispatch                   |
| [127](issues/127.md)      | Private class members (#field, #method)                 | strip # prefix, field initializers      |
| [128](issues/128.md)      | BigInt type                                             | i64 ops, literals, coercions            |
| [131](issues/131.md)      | String concatenation with variables                     | addStringImports + compound assign      |
| [132](issues/132.md)      | Logical operators returning values                      | already implemented, tests added        |
| [133](issues/133.md)      | typeof runtime comparison                               | static resolution + callable detect     |
| [134](issues/134.md)      | Switch fallthrough                                      | matched-flag rewrite                    |
| [135](issues/135.md)      | Ternary returning non-boolean values                    | type reconciliation across branches     |
| [136](issues/136.md)      | Loose equality (== / !=)                                | mixed-type coercion dispatch            |
| [137](issues/137.md)      | Object literal getter/setter                            | 3 in equivalence.test.ts                |
