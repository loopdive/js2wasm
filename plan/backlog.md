# ts2wasm Backlog

## Open issues

### Performance & infrastructure


| #                  | Feature                                                   | Complexity |
| ------------------ | --------------------------------------------------------- | ---------- |
| [70](issues/70.md) | Fast mode Phase 4 — C ABI for multi-language wasm linking | L          |
| [74](issues/74.md) | WASM SIMD for string and array operations                 | L          |
| [87](issues/87.md) | Math.round negative zero preservation                     | S          |


### Language coverage


| #                    | Feature                                            | Complexity |
| -------------------- | -------------------------------------------------- | ---------- |
| [79](issues/79.md)   | Gradual typing — boxed `any` with runtime dispatch | XL         |
| [81](issues/81.md)   | npm package resolution and tree-shaking            | L          |
| [100](issues/100.md) | Mutable closure captures via ref cells             | L          |


### Test262 conformance


| #                    | Feature                                                                   | Complexity |
| -------------------- | ------------------------------------------------------------------------- | ---------- |
| [101](issues/101.md) | Test262 — language/statements (for-of, for-in, class, generators, async)  | M          |
| [102](issues/102.md) | Test262 — language/expressions (new, arrow, class, object, array, spread) | M          |
| [103](issues/103.md) | Test262 — built-ins/String prototype methods                              | M          |
| [104](issues/104.md) | Test262 — language/ top-level (destructuring, defaults, rest, template)   | S          |
| [105](issues/105.md) | Test262 — built-ins/Map, built-ins/Set, built-ins/Promise                 | M          |
| [106](issues/106.md) | Test262 — built-ins/Object extended + built-ins/Array constructor         | M          |


### Compiler bugs (from test262 harvest)


| #                    | Feature                                                      | Complexity |
| -------------------- | ------------------------------------------------------------ | ---------- |
| [107](issues/107.md) | Fix codegen null-dereference crashes (90x in test262)        | M          |



## Complexity legend

- XS: < 50 lines, one file
- S: < 150 lines, 1–2 files
- M: < 400 lines, 2–3 files
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
| [9](issues/done/9.md)       | for-in loops                                            | —                                       |
| [10](issues/done/10.md)     | DOM support                                             | —                                       |
| [11](issues/done/11.md)     | Arrow function callbacks                                | —                                       |
| [12](issues/done/12.md)     | VS Code-like IDE layout for playground                  | —                                       |
| [13](issues/done/13.md)     | Template literals (substitutions)                       | —                                       |
| [14](issues/done/14.md)     | String methods                                          | —                                       |
| [15](issues/done/15.md)     | Ternary / conditional expression                        | —                                       |
| [16](issues/done/16.md)     | Optional chaining and nullish coalescing                | —                                       |
| [17](issues/done/17.md)     | Destructuring                                           | —                                       |
| [18](issues/done/18.md)     | Spread and rest operators                               | 13 in spread-rest.test.ts               |
| [19](issues/done/19.md)     | Type narrowing and union types                          | 4 in union-narrowing.test.ts            |
| [20](issues/done/20.md)     | Async/await and Promises (early spec)                   | superseded by #30                       |
| [21](issues/done/21.md)     | Array methods (early spec)                              | superseded by #26                       |
| [22](issues/done/22.md)     | Multi-file modules (early spec)                         | superseded by #28                       |
| [23](issues/done/23.md)     | Bitwise operators                                       | 14 in bitwise.test.ts                   |
| [24](issues/done/24.md)     | Exponentiation operator                                 | 1 in equivalence.test.ts                |
| [25](issues/done/25.md)     | Fix f32.const opcode in binary emitter                  | —                                       |
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
| [66](issues/done/66.md)     | Security design doc — runtime import hardening          | —                                       |
| [67](issues/done/67.md)     | Closed import objects                                   | in closed-imports.test.ts               |
| [68](issues/done/68.md)     | DOM containment                                         | in dom-containment.test.ts              |
| [69](issues/done/69.md)     | Safe mode — compile-time security checks                | 14 in safe-mode.test.ts                 |
| [70 Ph1](issues/done/31.md) | Fast mode Phase 1 — i32 default numbers                 | 13 in i32-fast-mode.test.ts             |
| [71](issues/done/71.md)     | Fast mode Phase 2 — WasmGC-native strings               | in native-strings.test.ts               |
| [72](issues/done/72.md)     | Fast mode Phase 3 — WasmGC-native arrays                | in native-arrays.test.ts                |
| [73](issues/done/73.md)     | Benchmark — JS vs host-call vs GC-native vs linear      | benchmark suite                         |
| [75](issues/done/75.md)     | Slice-based string views for substring/trim/slice       | in native-strings.test.ts               |
| [76](issues/done/76.md)     | Rope/cons-string for O(1) concatenation                 | in native-strings.test.ts               |
| [77](issues/done/77.md)     | Object literals, spread, structural typing              | in object-literals.test.ts              |
| [78](issues/done/78.md)     | Standard library coverage — builtins and static methods | in stdlib.test.ts                       |
| [80](issues/done/80.md)     | JS file compilation via `.d.ts` types                   | in js-compilation.test.ts               |
| [82](issues/done/82.md)     | Study V8, SpiderMonkey, Zena, AssemblyScript strategies | findings doc                            |
| [83](issues/done/83.md)     | Test262 conformance suite — Phase 1+2                   | in test262.test.ts                      |
| [84](issues/done/84.md)     | `var` hoisting support                                  | 5 in var-hoisting.test.ts               |
| [85](issues/done/85.md)     | Variadic `Math.min` / `Math.max`                        | in stdlib.test.ts                       |
| [86](issues/done/86.md)     | `new Array()` constructor expression                    | in array-methods.test.ts                |
| [88](issues/done/88.md)     | Test262 — language/expressions                          | 412 pass, 0 fail (6773 total)           |
| [89](issues/done/89.md)     | Test262 — language/statements                           | test262 stmt categories                 |
| [90](issues/done/90.md)     | Test262 — built-ins/Array                               | 20 Array prototype categories           |
| [91](issues/done/91.md)     | Test262 — built-ins/Number                              | EPSILON, MAX/MIN_SAFE_INTEGER           |
| [92](issues/done/92.md)     | Test262 — language/types (coercion)                     | all type categories pass                |
| [93](issues/done/93.md)     | Test262 — built-ins/Object                              | keys/values/entries categories          |
| [94](issues/done/94.md)     | Test262 — language/function-code                        | statements/function category            |
| [95](issues/done/95.md)     | Test262 — built-ins/isNaN + isFinite                    | already present, all pass               |
| [96](issues/done/96.md)     | Test262 — built-ins/JSON                                | JSON.parse 12/12, stringify skipped     |
| [97](issues/done/97.md)     | NaN/undefined/null truthiness fix                       | test262 + test_debug                    |
| [98](issues/done/98.md)     | ToInt32 for bitwise compound assignments                | test262 bitwise tests                   |
| [99](issues/done/99.md)     | Externref arithmetic/comparison/control                 | test262: 82%→100% compilable            |
| [100](issues/done/100.md)  | Mutable closure captures via ref cells                  | ref cell boxing codegen                 |
| [104](issues/done/104.md)  | Test262 — language/ top-level categories                | destructuring, rest, computed-props     |
| [108](issues/done/108.md)  | String(), Boolean(), Array() as conversion functions    | in equivalence tests                    |
| [110](issues/done/110.md)  | `in` operator for property existence test               | compile-time struct check               |
| [111](issues/done/111.md)  | ES2015+ Math methods (hypot, acosh, fround, …)          | inline + host imports                   |
| [112](issues/done/112.md)  | Number static methods (isSafeInteger, parseFloat, …)    | inline + delegation                     |
| [113](issues/done/113.md)  | Bug — "Object literal type not mapped to struct"        | inferred type fallback                  |
| [114](issues/done/114.md)  | Bug — "vec data field not ref" array codegen crash      | accept ref_null data fields             |
| [109](issues/109.md)      | Tagged template literals                                | runtime + codegen                       |
| [115](issues/done/115.md)  | Bug — var hoisting in function scope                    | pre-pass walkStmtForVars                |


