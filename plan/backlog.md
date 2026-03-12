# ts2wasm Backlog

## Sprint 3 (current)

_Goal: Fix runtime failures and reduce compile errors via string comparison, valueOf coercion, skip filter cleanup, BigInt fixes, and class/scope improvements._

| #   | Feature | Status | Group |
| --- | ------- | ------ | ----- |
| [225](issues/225.md) | For-loop continue/break with string !== comparison | Done | A |
| [226](issues/226.md) | valueOf/toString coercion on comparison operators | Done | A |
| [227](issues/227.md) | BigInt comparison with Infinity (float-unrepresentable trap) | In Progress | A |
| [228](issues/228.md) | BigInt equality/strict-equality with Number and Boolean | In Progress | A |
| [229](issues/229.md) | Tagged template cache: array out of bounds | In Progress | A |
| [230](issues/230.md) | Object computed property names with variable keys | In Progress | A |
| [231](issues/231.md) | Member expression property assignment on empty objects | Done | C |
| [232](issues/232.md) | Unsupported call expression -- method calls on object literals | In Progress | B |
| [233](issues/233.md) | Unknown identifier from destructuring in catch/for-of | Done | A |
| [234](issues/234.md) | ClassDeclaration in nested/expression positions | In Progress | B |
| [235](issues/235.md) | Function.name property access (380 compile errors) | In Progress | B |
| [236](issues/236.md) | allowJs type flexibility -- boolean/void/string as args | Done | C |
| [237](issues/237.md) | WebAssembly type mismatch -- BigInt i64 vs externref | In Progress | B |
| [238](issues/238.md) | Class expression new -- `new (class { ... })()` | In Progress | B |
| [239](issues/239.md) | Element access on struct types (bracket notation) | In Progress | B |
| [240](issues/240.md) | Setter return value -- allow return in setter bodies | Done | C |
| [241](issues/241.md) | Yield expression in strict mode / module context | In Progress | B |
| [242](issues/242.md) | Computed property names in class declarations | In Progress | C |
| [243](issues/243.md) | Unsupported assignment target patterns | In Progress | B |
| [244](issues/244.md) | `in` operator runtime failures | In Progress | A |
| [245](issues/245.md) | Switch statement with string case values | Done | A |
| [246](issues/246.md) | For-of object destructuring -- TypeError on primitive coercion | In Progress | A |
| [247](issues/247.md) | Arithmetic with null/undefined produces wrong results | In Progress | A |
| [248](issues/248.md) | Logical operators with object operands returning wrong values | Done | A |
| [249](issues/249.md) | Miscellaneous runtime failures -- remaining small fixes | In Progress | A |
| [250](issues/250.md) | For-loop with function declarations (113 compile errors) | In Progress | B |
| [251](issues/251.md) | super() call required in derived class constructors | Done | C |
| [252](issues/252.md) | Subsequent variable declarations type mismatch | Done | C |
| [253](issues/253.md) | Narrow skip filters -- typeof string comparison | Done | C |
| [254](issues/254.md) | Private class fields and methods (#field) | In Progress | C |
| [255](issues/255.md) | 'this' implicit any type in class methods | Done | C |
| [256](issues/256.md) | Unknown function: f -- locally declared functions not found | Done | C |

## Sprint 5

_Goal: Advanced compile error reduction, runtime correctness for all 62 remaining failures, test262 coverage expansion, and performance profiling. Target: reduce compile errors to ~2500, eliminate all runtime failures (62 -> 0), expand test categories._

| #   | Feature | Status | Group |
| --- | ------- | ------ | ----- |
| [287](issues/287.md) | Generator function compile errors -- yield in nested contexts | Open | A |
| [288](issues/288.md) | Try/catch/finally compile errors -- complex patterns | Open | A |
| [289](issues/289.md) | For-in compile errors -- property enumeration edge cases | Open | A |
| [290](issues/290.md) | Instanceof compile errors -- class hierarchy and expressions | Open | A |
| [291](issues/291.md) | In operator compile errors -- dynamic property checks | Open | A |
| [292](issues/292.md) | Runtime failures -- for-loop incorrect computed values | Open | B |
| [293](issues/293.md) | Runtime failures -- class method incorrect results | Open | B |
| [294](issues/294.md) | Runtime failures -- assignment expression evaluation order | Open | B |
| [295](issues/295.md) | Runtime failures -- comparison operators with type coercion | Open | B |
| [296](issues/296.md) | Runtime failures -- strict equality edge cases | Open | B |
| [297](issues/297.md) | Runtime failures -- switch statement fall-through | Open | B |
| [298](issues/298.md) | Runtime failures -- function statement edge cases | Open | B |
| [299](issues/299.md) | Runtime failures -- equals/does-not-equals loose comparison | Open | B |
| [300](issues/300.md) | Runtime failures -- object to primitive conversion | Open | B |
| [301](issues/301.md) | Runtime failures -- float unrepresentable in integer range | Open | B |
| [302](issues/302.md) | Runtime failures -- Math.min/max edge cases | Open | B |
| [303](issues/303.md) | Runtime failures -- parseInt edge cases | Open | B |
| [304](issues/304.md) | Runtime failures -- unary minus and return edge cases | Open | B |
| [305](issues/305.md) | Runtime failures -- computed property names and types/reference | Open | B |
| [306](issues/306.md) | Prefix/postfix increment/decrement compile errors | Open | C |
| [307](issues/307.md) | Promise.all and Promise.race compile errors | Open | C |
| [308](issues/308.md) | Addition operator compile errors -- string/number coercion | Open | C |
| [309](issues/309.md) | Expand test262 harness includes -- propertyIsEnumerable, fnGlobalObject | Open | D |
| [310](issues/310.md) | Reduce skip filters -- re-evaluate conservative skips | Open | D |
| [311](issues/311.md) | Test262 category expansion -- built-ins/String/prototype new methods | Open | D |
| [312](issues/312.md) | Test262 category expansion -- built-ins/Number methods | Open | D |
| [313](issues/313.md) | Test262 category expansion -- language/expressions new categories | Open | D |
| [314](issues/314.md) | Performance -- compile time profiling and optimization | Open | D |
| [315](issues/315.md) | Wasm validation error audit -- systematic fix for type mismatches | Open | C |
| [316](issues/316.md) | Runtime failure -- array element access out of bounds | Open | B |

## Sprint 4

_Goal: Reduce compile errors from ~3465 to ~2000 by fixing the most common error patterns: unsupported call expressions, ClassDeclaration positioning, argument type flexibility, property access, element access, iterator protocol, and scope resolution._

| #   | Feature | Status | Group |
| --- | ------- | ------ | ----- |
| [257](issues/257.md) | Unsupported call expression -- method calls on returned values | Open | A |
| [258](issues/258.md) | Unsupported call expression -- double/triple nested calls | Open | A |
| [259](issues/259.md) | ClassDeclaration in block/nested scope positions | Open | B |
| [260](issues/260.md) | ClassDeclaration + call expression combined errors | Open | B |
| [261](issues/261.md) | ClassDeclaration + new expression for anonymous classes | Open | B |
| [262](issues/262.md) | Argument type assignability -- allowJs flexibility for test262 | Open | C |
| [263](issues/263.md) | Property does not exist on type -- dynamic property access | Open | C |
| [264](issues/264.md) | Element access (bracket notation) on struct types | Open | C |
| [265](issues/265.md) | Computed property names in class declarations (TypeScript diagnostic) | Open | C |
| [266](issues/266.md) | Unknown identifier -- scope resolution for multi-variable patterns | Open | D |
| [267](issues/267.md) | Yield expression outside of generator function | Open | D |
| [268](issues/268.md) | Iterator protocol -- Type must have a Symbol.iterator method | Open | D |
| [269](issues/269.md) | Setter return value diagnostic suppression | Open | C |
| [270](issues/270.md) | Strict mode reserved words -- let, yield, package, etc. | Open | D |
| [271](issues/271.md) | Cannot find name -- missing harness or global declarations | Open | D |
| [272](issues/272.md) | WebAssembly type mismatch -- externref vs f64/i32 in compiled output | Open | A |
| [273](issues/273.md) | Unsupported new expression for anonymous class expressions | Open | B |
| [274](issues/274.md) | Property access on function type -- .name, .length, .call, .apply | Open | C |
| [275](issues/275.md) | Left side of comma operator warning blocks compilation | Open | C |
| [276](issues/276.md) | Computed property name must be of assignable type | Open | C |
| [277](issues/277.md) | WebAssembly type mismatch -- local.set externref vs concrete types | Open | A |
| [278](issues/278.md) | Cannot destructure -- not a known struct type | Open | D |
| [279](issues/279.md) | Arrow function compile errors -- parameter and body patterns | Open | A |
| [280](issues/280.md) | Function expression compile errors -- name binding and hoisting | Open | A |
| [281](issues/281.md) | Object literal property patterns -- shorthand, spread, methods | Open | C |
| [282](issues/282.md) | Variable declaration compile errors -- complex initializers | Open | D |
| [283](issues/283.md) | Compound assignment compile errors -- type coercion gaps | Open | A |
| [284](issues/284.md) | For-of compile errors -- destructuring and non-array iterables | Open | D |
| [285](issues/285.md) | For-loop compile errors -- complex heads and function declarations | Open | D |
| [286](issues/286.md) | Logical assignment compile errors -- nullish and short-circuit | Open | A |

## Sprint 1

_Goal: Eliminate all 146 test262 runtime failures (100% compilable pass rate) and reduce compile errors by ~700._
_Details: [sprint-1.md](sprint-1.md)_

| #   | Feature | Status | Assignee |
| --- | ------- | ------ | -------- |
| [138](issues/138.md) | Bug: valueOf/toString coercion on comparison operators | Open | — |
| [139](issues/139.md) | Bug: valueOf/toString coercion on arithmetic operators | Open | — |
| [140](issues/140.md) | Bug: object computed property names runtime | Open | — |
| [141](issues/141.md) | Bug: tagged template literal runtime failures | Open | — |
| [142](issues/142.md) | Bug: assignment destructuring failures | Open | — |
| [143](issues/143.md) | Bug: for-loop edge cases | Open | — |
| [144](issues/144.md) | Bug: new expression with class expressions | Open | — |
| [145](issues/145.md) | allowJs type flexibility: boolean/string/void as number | Open | — |
| [148](issues/148.md) | Element access (bracket notation) on struct types | Open | — |
| [150](issues/150.md) | ClassDeclaration in expression positions | Open | — |
| [151](issues/151.md) | `this` keyword in class methods for test262 | Open | — |
| [152](issues/152.md) | Setter return value error in allowJs mode | Open | — |
| [154](issues/154.md) | Bug: while/do-while loop condition evaluation | Open | — |
| [155](issues/155.md) | Bug: logical-and/logical-or short-circuit | Open | — |
| [156](issues/156.md) | Bug: conditional (ternary) expression evaluation | Open | — |
| [157](issues/157.md) | Bug: void expression returns wrong value | Open | — |
| [158](issues/158.md) | Bug: concatenation with non-string operands | Open | — |
| [159](issues/159.md) | Bug: call expression edge cases | Open | — |
| [160](issues/160.md) | Bug: Math method edge cases | Open | — |
| [161](issues/161.md) | Bug: compound assignment edge cases | Open | — |
| [162](issues/162.md) | Bug: switch statement matching | Open | — |
| [163](issues/163.md) | Bug: return statement edge cases | Open | — |
| [164](issues/164.md) | Bug: variable declaration edge cases | Open | — |
| [165](issues/165.md) | Bug: function statement hoisting and edge cases | Open | — |
| [166](issues/166.md) | Bug: `in` operator runtime failures | Open | — |
| [167](issues/167.md) | Bug: typeof edge cases | Open | — |
| [168](issues/168.md) | Bug: equality operators with null/undefined | Open | — |
| [169](issues/169.md) | Bug: arrow function edge case | Open | — |
| [170](issues/170.md) | Bug: class expression/declaration edge cases | Open | — |
| [171](issues/171.md) | Bug: Boolean() edge cases | Open | — |
| [172](issues/172.md) | Bug: Array.isArray edge case | Open | — |

## Backlog

### Core language features

| #                    | Feature                                            | Complexity | Tests blocked |
| -------------------- | -------------------------------------------------- | ---------- | ------------- |
| [130](issues/130.md) | Shape inference Phase 4 — hashmap fallback + more methods | L   | 2,200+        |
| [146](issues/146.md) | Unknown identifier / scope issues | M | ~269 |
| [147](issues/147.md) | Function.name property | M | ~258 |
| [149](issues/149.md) | Unsupported call expression patterns | L | ~637 |
| [153](issues/153.md) | Iterator protocol for destructuring | M | ~67 |
| [173](issues/173.md) | Computed property names in classes | M | ~44 |

### Won't implement (fundamental JS runtime features)

| #                    | Feature                                            | Reason                    |
| -------------------- | -------------------------------------------------- | ------------------------- |
| [123](issues/123.md) | Wrapper constructors (new Number/String/Boolean)   | JS legacy, TS discourages |
| [124](issues/124.md) | delete operator                                    | Fixed struct fields       |
| [125](issues/125.md) | Object.defineProperty / property descriptors       | Runtime metaprogramming   |
| [129](issues/129.md) | propertyHelper.js harness                          | Depends on #125           |



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
| [70 Ph4](issues/70.md)    | Fast mode Phase 4 — C ABI for multi-language linking    | c-abi.test.ts (38 tests)                |
| [79](issues/79.md)        | Gradual typing — boxed `any` with runtime dispatch      | 37 in equivalence.test.ts               |
| [81](issues/81.md)        | npm package resolution and tree-shaking                 | 18 in resolve.test.ts                   |
| [74](issues/74.md)        | WASM SIMD for string and array operations               | simd.test.ts + benchmarks               |
| [109](issues/done/109.md) | Tagged template literals                                | runtime + codegen                       |
| [115](issues/done/115.md)  | Bug — var hoisting in function scope                    | pre-pass walkStmtForVars                |
| [87](issues/done/87.md)   | Math.round negative zero preservation                   | inline wasm, -0 via copysign            |
| [101](issues/done/101.md) | Test262 — language/statements                           | for-of, for-in, class, generators, async|
| [102](issues/done/102.md) | Test262 — language/expressions                          | 22 expression categories                |
| [103](issues/done/103.md) | Test262 — built-ins/String/prototype                    | 21 String method categories             |
| [105](issues/done/105.md) | Test262 — Map/Set/Promise                               | 16 collection/promise categories        |
| [106](issues/done/106.md) | Test262 — Object/Array extended                         | Array.isArray + skip filters            |
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
| [181](issues/181.md)      | new Object() + new Function() skip                      | 8 in equivalence.test.ts                |
| [200](issues/200.md)      | JSON.stringify/parse externref coercion                  | 2 in equivalence.test.ts                |
| [205](issues/205.md)      | String.prototype.indexOf start position coercion         | 2 in equivalence.test.ts                |
| [246](issues/246.md)      | For-of object destructuring missing property defaults    | 3 in equivalence.test.ts                |
| [247](issues/247.md)      | Arithmetic with null/undefined produces wrong results     | 10 in equivalence.test.ts               |

