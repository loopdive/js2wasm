# ts2wasm Backlog

## Open issues

### Performance & infrastructure

| #                  | Feature                                                     | Complexity |
| ------------------ | ----------------------------------------------------------- | ---------- |
| [70](issues/70.md) | Fast mode Phases 2–4 (wasm-native strings, arrays, C ABI)  | L          |
| [73](issues/73.md) | Benchmark — JS vs host-call vs GC-native vs linear-memory  | M          |
| [74](issues/74.md) | WASM SIMD for string and array operations                  | L          |
| [75](issues/75.md) | Slice-based string views for substring/trim/slice          | M          |
| [76](issues/76.md) | Rope/cons-string for O(1) concatenation                    | L          |
| [82](issues/82.md) | Study V8, SpiderMonkey, Zena, AssemblyScript strategies    | M          |
| [83](issues/83.md) | Test262 conformance subset                                 | M          |

### Test262 conformance expansion

| #                  | Feature                                                     | Complexity | Priority |
| ------------------ | ----------------------------------------------------------- | ---------- | -------- |
| [88](issues/88.md) | Test262 — language/expressions                              | L          | High     |
| [89](issues/89.md) | Test262 — language/statements                               | L          | High     |
| [90](issues/90.md) | Test262 — built-ins/Array                                   | M          | High     |
| [91](issues/91.md) | Test262 — built-ins/Number, isNaN, isFinite                 | M          | High     |
| [92](issues/92.md) | Test262 — language/types (coercion)                         | M          | Medium   |
| [93](issues/93.md) | Test262 — built-ins/Object                                  | S          | Medium   |
| [94](issues/94.md) | Test262 — language/function-code                            | M          | Medium   |
| [95](issues/95.md) | Test262 — built-ins/isNaN + isFinite                        | S          | Medium   |
| [96](issues/96.md) | Test262 — built-ins/JSON                                    | S          | Low      |

### Compiler bugs (found via test262)

| #                  | Feature                                                     | Complexity |
| ------------------ | ----------------------------------------------------------- | ---------- |
| [98](issues/98.md) | Proper ToInt32 modular arithmetic for bitwise operations    | S          |

### Language coverage

| #                  | Feature                                                     | Complexity |
| ------------------ | ----------------------------------------------------------- | ---------- |
| [77](issues/77.md) | Object literals, spread, and structural typing              | L          |
| [78](issues/78.md) | Standard library coverage — builtins and static methods     | L          |
| [79](issues/79.md) | Gradual typing — boxed `any` with runtime dispatch          | XL         |
| [80](issues/80.md) | JS file compilation via `.d.ts` types and TS inference      | M          |
| [81](issues/81.md) | npm package resolution and tree-shaking                     | L          |

## Complexity legend

- XS: < 50 lines, one file
- S: < 150 lines, 1–2 files
- M: < 400 lines, 2–3 files
- L: > 400 lines, multiple files

## Completed

| #                       | Feature                                  | Tests                        |
| ----------------------- | ---------------------------------------- | ---------------------------- |
| [1](issues/done/1.md)   | do-while loops                           | 2 in control-flow.test.ts    |
| [2](issues/done/2.md)   | switch statements                        | 3 in control-flow.test.ts    |
| [3](issues/done/3.md)   | Arrays                                   | 5 in arrays-enums.test.ts    |
| [4](issues/done/4.md)   | for-of loops                             | 2 in control-flow.test.ts    |
| [5](issues/done/5.md)   | Enums                                    | 4 in arrays-enums.test.ts    |
| [6](issues/done/6.md)   | Classes                                  | in codegen (needs test file) |
| [7](issues/done/7.md)   | Closures / arrow functions               | in codegen (needs test file) |
| [8](issues/done/8.md)   | Generics                                 | 5 in generics.test.ts        |
| [9](issues/done/9.md)   | for-in loops                             | —                            |
| [10](issues/done/10.md) | DOM support                              | —                            |
| [11](issues/done/11.md) | Arrow function callbacks                 | —                            |
| [12](issues/done/12.md) | VS Code-like IDE layout for playground   | —                            |
| [13](issues/done/13.md) | Template literals (substitutions)        | —                            |
| [14](issues/done/14.md) | String methods                           | —                            |
| [15](issues/done/15.md) | Ternary / conditional expression         | —                            |
| [16](issues/done/16.md) | Optional chaining and nullish coalescing | —                            |
| [17](issues/done/17.md) | Destructuring                            | —                            |
| [18](issues/done/18.md) | Spread and rest operators                | 13 in spread-rest.test.ts    |
| [19](issues/done/19.md) | Type narrowing and union types           | 4 in union-narrowing.test.ts |
| [20](issues/done/20.md) | Async/await and Promises (early spec)    | superseded by #30            |
| [21](issues/done/21.md) | Array methods (early spec)               | superseded by #26            |
| [22](issues/done/22.md) | Multi-file modules (early spec)          | superseded by #28            |
| [23](issues/done/23.md) | Bitwise operators                        | 14 in bitwise.test.ts        |
| [24](issues/done/24.md) | Exponentiation operator                  | 1 in equivalence.test.ts     |
| [25](issues/done/25.md) | Fix f32.const opcode in binary emitter   | —                            |
| [26](issues/done/26.md) | Array methods via host imports           | 22 in array-methods.test.ts  |
| [27](issues/done/27.md) | Try/catch/throw                          | 8 in try-catch.test.ts       |
| [28](issues/done/28.md) | Multi-file module compilation            | 10 in multi-file.test.ts     |
| [29](issues/done/29.md) | Investigate failing tests                | fixed 2 in import-resolver   |
| [30](issues/done/30.md) | Async/await and Promises                 | 8 in async-await.test.ts     |
| [31](issues/31.md)      | Default number type to i32 (via fast mode) | 13 in i32-fast-mode.test.ts |
| [32](issues/done/32.md) | Capacity-based arrays with `array.copy`  | 4 in array-capacity.test.ts  |
| [33](issues/done/33.md) | Relocatable Wasm object file (.o) emission | in linker-e2e.test.ts      |
| [34](issues/done/34.md) | Multi-memory module linker               | in linker-e2e.test.ts        |
| [35](issues/done/35.md) | Class inheritance with extends and super | 7 in inheritance.test.ts     |
| [36](issues/done/36.md) | Static class members                     | 8 in static-members.test.ts  |
| [37](issues/done/37.md) | Getter/setter properties                 | 6 in getters-setters.test.ts |
| [38](issues/done/38.md) | Implement `instanceof` operator          | 4 in instanceof.test.ts      |
| [39](issues/done/39.md) | Labeled break and continue               | 7 in labeled-loops.test.ts   |
| [40](issues/done/40.md) | String enums                             | 5 in string-enums.test.ts    |
| [41](issues/done/41.md) | typeof as expression                     | 5 in typeof-expression.test.ts |
| [42](issues/done/42.md) | Comma operator                           | 5 in comma-operator.test.ts  |
| [43](issues/done/43.md) | void expression                          | 3 in void-expr.test.ts       |
| [44](issues/done/44.md) | Source map generation                    | 18 in sourcemap.test.ts      |
| [45](issues/done/45.md) | Error reporting with source locations    | 7 in error-reporting.test.ts |
| [47](issues/done/47.md) | importedStringConstants support          | 21 in imported-string-constants.test.ts |
| [48](issues/done/48.md) | Cache string literals in locals          | 9 in string-literal-cache.test.ts |
| [49](issues/done/49.md) | Default parameter values                 | 8 in default-params.test.ts  |
| [50](issues/done/50.md) | Nullish/logical assignment               | 11 in logical-assignment.test.ts |
| [51](issues/done/51.md) | Functional array methods                 | 24 in functional-array-methods.test.ts |
| [52](issues/done/52.md) | String.split()                           | 5 in string-split.test.ts    |
| [53](issues/done/53.md) | Numeric separators                       | 6 in numeric-separators.test.ts |
| [54](issues/done/54.md) | Map and Set collections                  | 19 in map-set.test.ts        |
| [55](issues/done/55.md) | Function expressions                     | 5 in function-expressions.test.ts |
| [56](issues/done/56.md) | Tuples                                   | 10 in tuples.test.ts         |
| [57](issues/done/57.md) | Class expressions                        | 3 in class-expressions.test.ts |
| [58](issues/done/58.md) | Iterators and for...of                   | 6 in iterators.test.ts       |
| [59](issues/done/59.md) | Abstract classes                         | 6 in abstract-classes.test.ts |
| [60](issues/done/60.md) | RegExp via host imports                  | in regexp.test.ts            |
| [61](issues/done/61.md) | Object.keys / Object.values / Object.entries | 13 in object-methods.test.ts |
| [62](issues/done/62.md) | JSON.parse / JSON.stringify              | 5 in json.test.ts            |
| [63](issues/done/63.md) | Promise.all / Promise.race               | 4 in promise-combinators.test.ts |
| [64](issues/done/64.md) | Generators and yield                     | 9 in generators.test.ts      |
| [65](issues/done/65.md) | Computed property names                  | 6 in computed-props.test.ts  |
| [66](issues/done/66.md) | Security design doc — runtime import hardening | —                      |
| [67](issues/done/67.md) | Closed import objects                    | in closed-imports.test.ts    |
| [68](issues/done/68.md) | DOM containment                          | in dom-containment.test.ts   |
| [69](issues/done/69.md) | Safe mode — compile-time security checks | 14 in safe-mode.test.ts      |
| [46](issues/done/46.md) | Linear-memory compilation backend        | 3 in linker-e2e.test.ts      |
| [70](issues/70.md)      | Fast mode Phase 1 — i32 default numbers  | 13 in i32-fast-mode.test.ts  |
| [97](issues/done/97.md) | NaN/undefined/null truthiness fix        | test262 + test_debug         |
| [99](issues/done/99.md) | Externref arithmetic/comparison/control  | test262: 82%→100% compilable |
