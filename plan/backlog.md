# ts2wasm Backlog

## Open issues


| #                  | Feature                                                     | Complexity |
| ------------------ | ----------------------------------------------------------- | ---------- |
| [31](issues/31.md) | Default number type to i32, promote to f64 only when needed | L          |
| [32](issues/32.md) | Capacity-based array representation with `array.copy`       | L          |


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
| [15](issues/done/15.md) | Ternary / conditional expressiongene     | —                            |
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
| [44](issues/44.md)      | Source map generation                    | 18 in sourcemap.test.ts      |


