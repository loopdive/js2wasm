# ts2wasm Backlog

## Sprint 3 (done)

_Goal: Fix runtime failures and reduce compile errors via string comparison, valueOf coercion, skip filter cleanup, BigInt fixes, and class/scope improvements._

| #   | Feature | Status | Group |
| --- | ------- | ------ | ----- |
| [225](../done/225.md) | For-loop continue/break with string !== comparison | Done | A |
| [226](../done/226.md) | valueOf/toString coercion on comparison operators | Done | A |
| [227](../ready/227.md) | BigInt comparison with Infinity (float-unrepresentable trap) | In Progress | A |
| [228](../ready/228.md) | BigInt equality/strict-equality with Number and Boolean | In Progress | A |
| [229](../ready/229.md) | Tagged template cache: array out of bounds | In Progress | A |
| [230](../ready/230.md) | Object computed property names with variable keys | In Progress | A |
| [231](../done/231.md) | Member expression property assignment on empty objects | Done | C |
| [232](../ready/232.md) | Unsupported call expression -- method calls on object literals | In Progress | B |
| [233](../done/233.md) | Unknown identifier from destructuring in catch/for-of | Done | A |
| [234](../ready/234.md) | ClassDeclaration in nested/expression positions | In Progress | B |
| [235](../ready/235.md) | Function.name property access (380 compile errors) | In Progress | B |
| [236](../done/236.md) | allowJs type flexibility -- boolean/void/string as args | Done | C |
| [237](../ready/237.md) | WebAssembly type mismatch -- BigInt i64 vs externref | In Progress | B |
| [238](../ready/238.md) | Class expression new -- `new (class { ... })()` | In Progress | B |
| [239](../ready/239.md) | Element access on struct types (bracket notation) | In Progress | B |
| [240](../done/240.md) | Setter return value -- allow return in setter bodies | Done | C |
| [241](../ready/241.md) | Yield expression in strict mode / module context | In Progress | B |
| [242](../ready/242.md) | Computed property names in class declarations | In Progress | C |
| [243](../ready/243.md) | Unsupported assignment target patterns | In Progress | B |
| [244](../ready/244.md) | `in` operator runtime failures | In Progress | A |
| [245](../done/245.md) | Switch statement with string case values | Done | A |
| [246](../done/246.md) | For-of object destructuring -- TypeError on primitive coercion | In Progress | A |
| [247](../done/247.md) | Arithmetic with null/undefined produces wrong results | In Progress | A |
| [248](../done/248.md) | Logical operators with object operands returning wrong values | Done | A |
| [249](../ready/249.md) | Miscellaneous runtime failures -- remaining small fixes | In Progress | A |
| [250](../ready/250.md) | For-loop with function declarations (113 compile errors) | In Progress | B |
| [251](../done/251.md) | super() call required in derived class constructors | Done | C |
| [252](../done/252.md) | Subsequent variable declarations type mismatch | Done | C |
| [253](../done/253.md) | Narrow skip filters -- typeof string comparison | Done | C |
| [254](../done/254.md) | Private class fields and methods (#field) | Done | C |
| [255](../done/255.md) | 'this' implicit any type in class methods | Done | C |
| [256](../done/256.md) | Unknown function: f -- locally declared functions not found | Done | C |

## Sprint 5

_Goal: Fix silent correctness bugs and high-impact compile errors. Focus: no wrong output, no invalid Wasm, unblock the most common language patterns._

### Tier 1 — Silent correctness bugs (wrong output / invalid Wasm)

| #   | Feature | Status | Tests |
| --- | ------- | ------ | ----- |
| [321](../ready/321.md) | Collection functions don't scan top-level statements (__module_init) | Open | **P0** |
| [317](../done/317.md) | Unused $AnyValue preamble type + duplicate export cleanup | **Done** | **P0** |
| [315](../ready/315.md) | Wasm validation error audit -- systematic fix for type mismatches | Open | ~93 |
| [292](../ready/292.md) | Runtime failures -- for-loop incorrect computed values | Open | 15 |
| [293](../ready/293.md) | Runtime failures -- class method incorrect results | Open | 10 |
| [295](../ready/295.md) | Runtime failures -- comparison operators with type coercion | Open | 8 |
| [294](../ready/294.md) | Runtime failures -- assignment expression evaluation order | Open | 7 |
| [300](../ready/300.md) | Runtime failures -- object to primitive conversion | Open | 5 |
| [296](../ready/296.md) | Runtime failures -- strict equality edge cases | Open | 4 |

### Tier 2 — High-impact compile error fixes

| #   | Feature | Status | Tests |
| --- | ------- | ------ | ----- |
| [287](../ready/287.md) | Generator function compile errors -- yield in nested contexts | Open | ~119 |
| [306](../ready/306.md) | Prefix/postfix increment/decrement compile errors | Open | ~44 |
| [288](../ready/288.md) | Try/catch/finally compile errors -- complex patterns | Open | ~40 |
| [290](../ready/290.md) | Instanceof compile errors -- class hierarchy and expressions | Open | ~20 |
| [308](../ready/308.md) | Addition operator compile errors -- string/number coercion | Open | 7 |

## Sprint 6

_Goal: Remaining runtime failures, codegen quality, and test infrastructure expansion._

### Runtime failures (remaining)

| #   | Feature | Status | Tests |
| --- | ------- | ------ | ----- |
| [297](../ready/297.md) | Runtime failures -- switch statement fall-through | Open | 2 |
| [298](../ready/298.md) | Runtime failures -- function statement edge cases | Open | 2 |
| [299](../ready/299.md) | Runtime failures -- equals/does-not-equals loose comparison | Open | 2 |
| [301](../ready/301.md) | Runtime failures -- float unrepresentable in integer range | Open | 4 |
| [302](../ready/302.md) | Runtime failures -- Math.min/max edge cases | Open | 2 |
| [303](../ready/303.md) | Runtime failures -- parseInt edge cases | Open | 1 |
| [304](../ready/304.md) | Runtime failures -- unary minus and return edge cases | Open | 2 |
| [305](../ready/305.md) | Runtime failures -- computed property names and types/reference | Review | 2 |
| [316](../done/316.md) | Runtime failure -- array element access out of bounds | Done | 1 |

### Compile error fixes (lower impact)

| #   | Feature | Status | Tests |
| --- | ------- | ------ | ----- |
| [289](../ready/289.md) | For-in compile errors -- property enumeration edge cases | Open | ~13 |
| [291](../ready/291.md) | In operator compile errors -- dynamic property checks | Open | ~10 |
| [307](../done/307.md) | Promise.all and Promise.race compile errors | **Done** | 7 |

### Codegen quality

| #   | Feature | Status |
| --- | ------- | ------ |
| [320](../ready/320.md) | Dead import and type elimination (umbrella) | Open |
| [318](../done/318.md) | Infer parameter types from call-site arguments for untyped functions | Done |
| [319](../ready/319.md) | Inline single-use function type signatures in WAT output | Open |

### Test infrastructure

| #   | Feature | Status |
| --- | ------- | ------ |
| [309](../ready/309.md) | Expand test262 harness includes -- propertyIsEnumerable, fnGlobalObject | Open |
| [310](../ready/310.md) | Reduce skip filters -- re-evaluate conservative skips | Open |
| [311](../done/311.md) | Test262 category expansion -- built-ins/String/prototype new methods | Done |
| [312](../ready/312.md) | Test262 category expansion -- built-ins/Number methods | Open |
| [313](../ready/313.md) | Test262 category expansion -- language/expressions new categories | Open |
| [314](../ready/314.md) | Performance -- compile time profiling and optimization | Open |

### Future (low priority)

| #   | Feature | Status |
| --- | ------- | ------ |
| [322](../ready/322.md) | Inline trig/transcendental Math methods as pure Wasm | Open |
| [323](../ready/323.md) | Native type annotations (:i32, :f32, :u8) for performance | Open |

## Current — Test262 Error-Driven (March 2026)

_Updated baseline (2026-03-16): 22,959 tests — 5,312 pass (23.1%), 2,010 fail, 7,314 CE, 8,323 skip. Issues prioritized by test impact, executed dependency-driven (see `plan/dependency-graph.md`)._

### Wasm validation (3,672 CE) — CRITICAL

| #   | Feature | Type | Count |
| --- | ------- | ---- | ----- |
| [401](../ready/401.md) | Wasm validation errors (call args, struct.new, type mismatch, stack) | CE | 3672 |

### Destructuring (1,219 tests blocked)

| #   | Feature | Type | Count |
| --- | ------- | ---- | ----- |
| [394](../ready/394.md) | Destructuring wrong return values | FAIL | 1438 |
| [396](../ready/396.md) | Null pointer in destructuring | FAIL | 118 |
| [387](../ready/387.md) | Unsupported call expression (71% destructuring) | CE | 2356 |
| [388](../ready/388.md) | Element access on externref | CE | 104 |
| [389](../ready/389.md) | Element access on class instances | CE | 76 |
| [390](../ready/390.md) | Assignment to non-array types | CE | 70 |

### Class & runtime failures

| #   | Feature | Type | Count |
| --- | ------- | ---- | ----- |
| [398](../ready/398.md) | Private field/method wrong values | FAIL | 98 |
| [399](../ready/399.md) | Prototype method wrong values | FAIL | 72 |
| [395](../ready/395.md) | "fn is not a function" (call/apply + callbacks) | FAIL | 70 |
| [392](../ready/392.md) | Unknown field access on class structs | CE | 18 |

### Compile error patterns

| #   | Feature | Type | Count |
| --- | ------- | ---- | ----- |
| [404](../ready/404.md) | Compound assignment on unresolvable property type | CE | 88 |
| [403](../ready/403.md) | import.source meta-property errors | CE | 86 |
| [406](../ready/406.md) | 'base' is possibly null errors | CE | 81 |
| [405](../ready/405.md) | Internal compiler errors (undefined properties) | CE | 64 |
| [407](../ready/407.md) | Deferred imports module flag error | CE | 54 |
| [391](../ready/391.md) | Numeric index signature on objects | CE | 30 |
| [393](../ready/393.md) | Compound assignment on externref element | CE | 13 |

### Test infrastructure

| #   | Feature | Type | Count |
| --- | ------- | ---- | ----- |
| [402](../ready/402.md) | Negative tests: expected SyntaxError not raised | FAIL | 434 |
| [397](../ready/397.md) | assert.throws test support | SKIP | 952 |

---

## Sprint 4 (legacy)

_Goal: Reduce compile errors from ~3465 to ~2000 by fixing the most common error patterns: unsupported call expressions, ClassDeclaration positioning, argument type flexibility, property access, element access, iterator protocol, and scope resolution._

| #   | Feature | Status | Group |
| --- | ------- | ------ | ----- |
| [257](../ready/257.md) | Unsupported call expression -- method calls on returned values | Open | A |
| [258](../ready/258.md) | Unsupported call expression -- double/triple nested calls | Open | A |
| [259](../ready/259.md) | ClassDeclaration in block/nested scope positions | Open | B |
| [260](../ready/260.md) | ClassDeclaration + call expression combined errors | Open | B |
| [261](../ready/261.md) | ClassDeclaration + new expression for anonymous classes | Open | B |
| [262](../ready/262.md) | Argument type assignability -- allowJs flexibility for test262 | Open | C |
| [263](../ready/263.md) | Property does not exist on type -- dynamic property access | Open | C |
| [264](../ready/264.md) | Element access (bracket notation) on struct types | Open | C |
| [265](../ready/265.md) | Computed property names in class declarations (TypeScript diagnostic) | Open | C |
| [266](../ready/266.md) | Unknown identifier -- scope resolution for multi-variable patterns | Open | D |
| [267](../ready/267.md) | Yield expression outside of generator function | Open | D |
| [268](../ready/268.md) | Iterator protocol -- Type must have a Symbol.iterator method | Open | D |
| [269](../ready/269.md) | Setter return value diagnostic suppression | Open | C |
| [270](../ready/270.md) | Strict mode reserved words -- let, yield, package, etc. | Open | D |
| [271](../ready/271.md) | Cannot find name -- missing harness or global declarations | Open | D |
| [272](../ready/272.md) | WebAssembly type mismatch -- externref vs f64/i32 in compiled output | Open | A |
| [273](../ready/273.md) | Unsupported new expression for anonymous class expressions | Open | B |
| [274](../ready/274.md) | Property access on function type -- .name, .length, .call, .apply | Open | C |
| [275](../ready/275.md) | Left side of comma operator warning blocks compilation | Open | C |
| [276](../ready/276.md) | Computed property name must be of assignable type | Open | C |
| [277](../ready/277.md) | WebAssembly type mismatch -- local.set externref vs concrete types | Open | A |
| [278](../ready/278.md) | Cannot destructure -- not a known struct type | Open | D |
| [279](../ready/279.md) | Arrow function compile errors -- parameter and body patterns | Open | A |
| [280](../ready/280.md) | Function expression compile errors -- name binding and hoisting | Open | A |
| [281](../ready/281.md) | Object literal property patterns -- shorthand, spread, methods | Open | C |
| [282](../ready/282.md) | Variable declaration compile errors -- complex initializers | Open | D |
| [283](../ready/283.md) | Compound assignment compile errors -- type coercion gaps | Open | A |
| [284](../done/284.md) | For-of compile errors -- destructuring and non-array iterables | Done | D |
| [285](../ready/285.md) | For-loop compile errors -- complex heads and function declarations | Open | D |
| [286](../ready/286.md) | Logical assignment compile errors -- nullish and short-circuit | Open | A |

## Sprint 1

_Goal: Eliminate all 146 test262 runtime failures (100% compilable pass rate) and reduce compile errors by ~700._
_Details: [sprint.md](../ready/sprint.md)_

| #   | Feature | Status | Assignee |
| --- | ------- | ------ | -------- |
| [138](../ready/138.md) | Bug: valueOf/toString coercion on comparison operators | Open | — |
| [139](../done/139.md) | Bug: valueOf/toString coercion on arithmetic operators | Done | 2026-03-13 |
| [140](../ready/140.md) | Bug: object computed property names runtime | Open | — |
| [141](../done/141.md) | Bug: tagged template literal runtime failures | Done | 2026-03-13 |
| [142](../ready/142.md) | Bug: assignment destructuring failures | Open | — |
| [143](../ready/143.md) | Bug: for-loop edge cases | Open | — |
| [144](../ready/144.md) | Bug: new expression with class expressions | Open | — |
| [145](../ready/145.md) | allowJs type flexibility: boolean/string/void as number | Open | — |
| [148](../ready/148.md) | Element access (bracket notation) on struct types | Open | — |
| [150](../ready/150.md) | ClassDeclaration in expression positions | Open | — |
| [151](../ready/151.md) | `this` keyword in class methods for test262 | Open | — |
| [152](../ready/152.md) | Setter return value error in allowJs mode | Open | — |
| [154](../ready/154.md) | Bug: while/do-while loop condition evaluation | Open | — |
| [155](../ready/155.md) | Bug: logical-and/logical-or short-circuit | Open | — |
| [156](../ready/156.md) | Bug: conditional (ternary) expression evaluation | Open | — |
| [157](../ready/157.md) | Bug: void expression returns wrong value | Open | — |
| [158](../ready/158.md) | Bug: concatenation with non-string operands | Open | — |
| [159](../ready/159.md) | Bug: call expression edge cases | Open | — |
| [160](../ready/160.md) | Bug: Math method edge cases | Open | — |
| [161](../ready/161.md) | Bug: compound assignment edge cases | Open | — |
| [162](../ready/162.md) | Bug: switch statement matching | Open | — |
| [163](../ready/163.md) | Bug: return statement edge cases | Open | — |
| [164](../ready/164.md) | Bug: variable declaration edge cases | Open | — |
| [165](../ready/165.md) | Bug: function statement hoisting and edge cases | Open | — |
| [166](../ready/166.md) | Bug: `in` operator runtime failures | Open | — |
| [167](../ready/167.md) | Bug: typeof edge cases | Open | — |
| [168](../ready/168.md) | Bug: equality operators with null/undefined | Open | — |
| [169](../ready/169.md) | Bug: arrow function edge case | Open | — |
| [170](../ready/170.md) | Bug: class expression/declaration edge cases | Open | — |
| [171](../ready/171.md) | Bug: Boolean() edge cases | Open | — |
| [172](../ready/172.md) | Bug: Array.isArray edge case | Open | — |

## Backlog

### Core language features

| #                    | Feature                                            | Complexity | Tests blocked |
| -------------------- | -------------------------------------------------- | ---------- | ------------- |
| [130](./130.md) | Shape inference Phase 4 — hashmap fallback + more methods | L   | 2,200+        |
| [146](./146.md) | Unknown identifier / scope issues | M | ~269 |
| [147](./147.md) | Function.name property | M | ~258 |
| [149](./149.md) | Unsupported call expression patterns | L | ~637 |
| [153](./153.md) | Iterator protocol for destructuring | M | ~67 |
| [173](./173.md) | Computed property names in classes | M | ~44 | **review** |

### Won't implement (fundamental JS runtime features)

| #                    | Feature                                            | Reason                    |
| -------------------- | -------------------------------------------------- | ------------------------- |
| [123](./123.md) | Wrapper constructors (new Number/String/Boolean)   | JS legacy, TS discourages |
| [124](./124.md) | delete operator                                    | Fixed struct fields       |
| [125](./125.md) | Object.defineProperty / property descriptors       | Runtime metaprogramming   |
| [129](./129.md) | propertyHelper.js harness                          | Depends on #125           |



## Complexity legend

- XS: < 50 lines, one file
- S: < 150 lines, 1–2 files
- M: < 400 lines, 2–3 files
- L: > 400 lines, multiple files

## Completed


| #                           | Feature                                                 | Tests                                   |
| --------------------------- | ------------------------------------------------------- | --------------------------------------- |
| [1](../done/1.md)       | do-while loops                                          | 2 in control-flow.test.ts               |
| [2](../done/2.md)       | switch statements                                       | 3 in control-flow.test.ts               |
| [3](../done/3.md)       | Arrays                                                  | 5 in arrays-enums.test.ts               |
| [4](../done/4.md)       | for-of loops                                            | 2 in control-flow.test.ts               |
| [5](../done/5.md)       | Enums                                                   | 4 in arrays-enums.test.ts               |
| [6](../done/6.md)       | Classes                                                 | in codegen (needs test file)            |
| [7](../done/7.md)       | Closures / arrow functions                              | in codegen (needs test file)            |
| [8](../done/8.md)       | Generics                                                | 5 in generics.test.ts                   |
| [9](../done/9.md)       | for-in loops                                            | —                                       |
| [10](../done/10.md)     | DOM support                                             | —                                       |
| [11](../done/11.md)     | Arrow function callbacks                                | —                                       |
| [12](../done/12.md)     | VS Code-like IDE layout for playground                  | —                                       |
| [13](../done/13.md)     | Template literals (substitutions)                       | —                                       |
| [14](../done/14.md)     | String methods                                          | —                                       |
| [15](../done/15.md)     | Ternary / conditional expression                        | —                                       |
| [16](../done/16.md)     | Optional chaining and nullish coalescing                | —                                       |
| [17](../done/17.md)     | Destructuring                                           | —                                       |
| [18](../done/18.md)     | Spread and rest operators                               | 13 in spread-rest.test.ts               |
| [19](../done/19.md)     | Type narrowing and union types                          | 4 in union-narrowing.test.ts            |
| [20](../done/20.md)     | Async/await and Promises (early spec)                   | superseded by #30                       |
| [21](../done/21.md)     | Array methods (early spec)                              | superseded by #26                       |
| [22](../done/22.md)     | Multi-file modules (early spec)                         | superseded by #28                       |
| [23](../done/23.md)     | Bitwise operators                                       | 14 in bitwise.test.ts                   |
| [24](../done/24.md)     | Exponentiation operator                                 | 1 in equivalence.test.ts                |
| [25](../done/25.md)     | Fix f32.const opcode in binary emitter                  | —                                       |
| [26](../done/26.md)     | Array methods via host imports                          | 22 in array-methods.test.ts             |
| [27](../done/27.md)     | Try/catch/throw                                         | 8 in try-catch.test.ts                  |
| [28](../done/28.md)     | Multi-file module compilation                           | 10 in multi-file.test.ts                |
| [29](../done/29.md)     | Investigate failing tests                               | fixed 2 in import-resolver              |
| [30](../done/30.md)     | Async/await and Promises                                | 8 in async-await.test.ts                |
| [31](../done/31.md)     | Default number type to i32 (via fast mode)              | 13 in i32-fast-mode.test.ts             |
| [32](../done/32.md)     | Capacity-based arrays with `array.copy`                 | 4 in array-capacity.test.ts             |
| [33](../done/33.md)     | Relocatable Wasm object file (.o) emission              | in linker-e2e.test.ts                   |
| [34](../done/34.md)     | Multi-memory module linker                              | in linker-e2e.test.ts                   |
| [35](../done/35.md)     | Class inheritance with extends and super                | 7 in inheritance.test.ts                |
| [36](../done/36.md)     | Static class members                                    | 8 in static-members.test.ts             |
| [37](../done/37.md)     | Getter/setter properties                                | 6 in getters-setters.test.ts            |
| [38](../done/38.md)     | Implement `instanceof` operator                         | 4 in instanceof.test.ts                 |
| [39](../done/39.md)     | Labeled break and continue                              | 7 in labeled-loops.test.ts              |
| [40](../done/40.md)     | String enums                                            | 5 in string-enums.test.ts               |
| [41](../done/41.md)     | typeof as expression                                    | 5 in typeof-expression.test.ts          |
| [42](../done/42.md)     | Comma operator                                          | 5 in comma-operator.test.ts             |
| [43](../done/43.md)     | void expression                                         | 3 in void-expr.test.ts                  |
| [44](../done/44.md)     | Source map generation                                   | 18 in sourcemap.test.ts                 |
| [45](../done/45.md)     | Error reporting with source locations                   | 7 in error-reporting.test.ts            |
| [46](../done/46.md)     | Linear-memory compilation backend                       | 3 in linker-e2e.test.ts                 |
| [47](../done/47.md)     | importedStringConstants support                         | 21 in imported-string-constants.test.ts |
| [48](../done/48.md)     | Cache string literals in locals                         | 9 in string-literal-cache.test.ts       |
| [49](../done/49.md)     | Default parameter values                                | 8 in default-params.test.ts             |
| [50](../done/50.md)     | Nullish/logical assignment                              | 11 in logical-assignment.test.ts        |
| [51](../done/51.md)     | Functional array methods                                | 24 in functional-array-methods.test.ts  |
| [52](../done/52.md)     | String.split()                                          | 5 in string-split.test.ts               |
| [53](../done/53.md)     | Numeric separators                                      | 6 in numeric-separators.test.ts         |
| [54](../done/54.md)     | Map and Set collections                                 | 19 in map-set.test.ts                   |
| [55](../done/55.md)     | Function expressions                                    | 5 in function-expressions.test.ts       |
| [56](../done/56.md)     | Tuples                                                  | 10 in tuples.test.ts                    |
| [57](../done/57.md)     | Class expressions                                       | 3 in class-expressions.test.ts          |
| [58](../done/58.md)     | Iterators and for...of                                  | 6 in iterators.test.ts                  |
| [59](../done/59.md)     | Abstract classes                                        | 6 in abstract-classes.test.ts           |
| [60](../done/60.md)     | RegExp via host imports                                 | in regexp.test.ts                       |
| [61](../done/61.md)     | Object.keys / Object.values / Object.entries            | 13 in object-methods.test.ts            |
| [62](../done/62.md)     | JSON.parse / JSON.stringify                             | 5 in json.test.ts                       |
| [63](../done/63.md)     | Promise.all / Promise.race                              | 4 in promise-combinators.test.ts        |
| [64](../done/64.md)     | Generators and yield                                    | 9 in generators.test.ts                 |
| [65](../done/65.md)     | Computed property names                                 | 6 in computed-props.test.ts             |
| [66](../done/66.md)     | Security design doc — runtime import hardening          | —                                       |
| [67](../done/67.md)     | Closed import objects                                   | in closed-imports.test.ts               |
| [68](../done/68.md)     | DOM containment                                         | in dom-containment.test.ts              |
| [69](../done/69.md)     | Safe mode — compile-time security checks                | 14 in safe-mode.test.ts                 |
| [70 Ph1](../done/31.md) | Fast mode Phase 1 — i32 default numbers                 | 13 in i32-fast-mode.test.ts             |
| [71](../done/71.md)     | Fast mode Phase 2 — WasmGC-native strings               | in native-strings.test.ts               |
| [72](../done/72.md)     | Fast mode Phase 3 — WasmGC-native arrays                | in native-arrays.test.ts                |
| [73](../done/73.md)     | Benchmark — JS vs host-call vs GC-native vs linear      | benchmark suite                         |
| [75](../done/75.md)     | Slice-based string views for substring/trim/slice       | in native-strings.test.ts               |
| [76](../done/76.md)     | Rope/cons-string for O(1) concatenation                 | in native-strings.test.ts               |
| [77](../done/77.md)     | Object literals, spread, structural typing              | in object-literals.test.ts              |
| [78](../done/78.md)     | Standard library coverage — builtins and static methods | in stdlib.test.ts                       |
| [80](../done/80.md)     | JS file compilation via `.d.ts` types                   | in js-compilation.test.ts               |
| [82](../done/82.md)     | Study V8, SpiderMonkey, Zena, AssemblyScript strategies | findings doc                            |
| [83](../done/83.md)     | Test262 conformance suite — Phase 1+2                   | in test262.test.ts                      |
| [84](../done/84.md)     | `var` hoisting support                                  | 5 in var-hoisting.test.ts               |
| [85](../done/85.md)     | Variadic `Math.min` / `Math.max`                        | in stdlib.test.ts                       |
| [86](../done/86.md)     | `new Array()` constructor expression                    | in array-methods.test.ts                |
| [88](../done/88.md)     | Test262 — language/expressions                          | 412 pass, 0 fail (6773 total)           |
| [89](../done/89.md)     | Test262 — language/statements                           | test262 stmt categories                 |
| [90](../done/90.md)     | Test262 — built-ins/Array                               | 20 Array prototype categories           |
| [91](../done/91.md)     | Test262 — built-ins/Number                              | EPSILON, MAX/MIN_SAFE_INTEGER           |
| [92](../done/92.md)     | Test262 — language/types (coercion)                     | all type categories pass                |
| [93](../done/93.md)     | Test262 — built-ins/Object                              | keys/values/entries categories          |
| [94](../done/94.md)     | Test262 — language/function-code                        | statements/function category            |
| [95](../done/95.md)     | Test262 — built-ins/isNaN + isFinite                    | already present, all pass               |
| [96](../done/96.md)     | Test262 — built-ins/JSON                                | JSON.parse 12/12, stringify skipped     |
| [97](../done/97.md)     | NaN/undefined/null truthiness fix                       | test262 + test_debug                    |
| [98](../done/98.md)     | ToInt32 for bitwise compound assignments                | test262 bitwise tests                   |
| [99](../done/99.md)     | Externref arithmetic/comparison/control                 | test262: 82%→100% compilable            |
| [100](../done/100.md)  | Mutable closure captures via ref cells                  | ref cell boxing codegen                 |
| [104](../done/104.md)  | Test262 — language/ top-level categories                | destructuring, rest, computed-props     |
| [108](../done/108.md)  | String(), Boolean(), Array() as conversion functions    | in equivalence tests                    |
| [110](../done/110.md)  | `in` operator for property existence test               | compile-time struct check               |
| [111](../done/111.md)  | ES2015+ Math methods (hypot, acosh, fround, …)          | inline + host imports                   |
| [112](../done/112.md)  | Number static methods (isSafeInteger, parseFloat, …)    | inline + delegation                     |
| [113](../done/113.md)  | Bug — "Object literal type not mapped to struct"        | inferred type fallback                  |
| [114](../done/114.md)  | Bug — "vec data field not ref" array codegen crash      | accept ref_null data fields             |
| [70 Ph4](./70.md)    | Fast mode Phase 4 — C ABI for multi-language linking    | c-abi.test.ts (38 tests)                |
| [79](./79.md)        | Gradual typing — boxed `any` with runtime dispatch      | 37 in equivalence.test.ts               |
| [81](./81.md)        | npm package resolution and tree-shaking                 | 18 in resolve.test.ts                   |
| [74](./74.md)        | WASM SIMD for string and array operations               | simd.test.ts + benchmarks               |
| [109](../done/109.md) | Tagged template literals                                | runtime + codegen                       |
| [115](../done/115.md)  | Bug — var hoisting in function scope                    | pre-pass walkStmtForVars                |
| [87](../done/87.md)   | Math.round negative zero preservation                   | inline wasm, -0 via copysign            |
| [101](../done/101.md) | Test262 — language/statements                           | for-of, for-in, class, generators, async|
| [102](../done/102.md) | Test262 — language/expressions                          | 22 expression categories                |
| [103](../done/103.md) | Test262 — built-ins/String/prototype                    | 21 String method categories             |
| [105](../done/105.md) | Test262 — Map/Set/Promise                               | 16 collection/promise categories        |
| [106](../done/106.md) | Test262 — Object/Array extended                         | Array.isArray + skip filters            |
| [107](../done/107.md) | Fix codegen null-dereference crashes                    | try-catch + null guards                 |
| [116](../done/116.md)      | Unskip implemented features in test262 runner           | 26 features unskipped, +13 passing      |
| [117](../done/117.md)      | String comparison in test262 harness                    | assert_sameValue_str                    |
| [118](../done/118.md)      | compareArray.js test262 harness shim                    | compareArray shim                       |
| [130 Ph1-3](./130.md)| Shape inference + call/apply inlining                   | 4 in equivalence.test.ts                |
| [119](../done/119.md)      | assert.throws support in test262 harness                | removeAssertThrows()                    |
| [120](../done/120.md)      | undefined/void 0 comparison support                     | stripUndefinedThrowGuards()             |
| [122](../done/122.md)      | arguments object                                        | vec struct from params                  |
| [126](../done/126.md)      | valueOf/toString coercion                               | class method dispatch                   |
| [127](../done/127.md)      | Private class members (#field, #method)                 | strip # prefix, field initializers      |
| [128](../done/128.md)      | BigInt type                                             | i64 ops, literals, coercions            |
| [131](../done/131.md)      | String concatenation with variables                     | addStringImports + compound assign      |
| [132](../done/132.md)      | Logical operators returning values                      | already implemented, tests added        |
| [133](../done/133.md)      | typeof runtime comparison                               | static resolution + callable detect     |
| [134](../done/134.md)      | Switch fallthrough                                      | matched-flag rewrite                    |
| [135](../done/135.md)      | Ternary returning non-boolean values                    | type reconciliation across branches     |
| [136](../done/136.md)      | Loose equality (== / !=)                                | mixed-type coercion dispatch            |
| [137](../done/137.md)      | Object literal getter/setter                            | 3 in equivalence.test.ts                |
| [181](../done/181.md)      | new Object() + new Function() skip                      | 8 in equivalence.test.ts                |
| [200](../done/200.md)      | JSON.stringify/parse externref coercion                  | 2 in equivalence.test.ts                |
| [205](../done/205.md)      | String.prototype.indexOf start position coercion         | 2 in equivalence.test.ts                |
| [246](../done/246.md)      | For-of object destructuring missing property defaults    | 3 in equivalence.test.ts                |
| [247](../done/247.md)      | Arithmetic with null/undefined produces wrong results     | 10 in equivalence.test.ts               |

