# ts2wasm Backlog

## Open issues

(none)

## Complexity legend

- XS: < 50 lines, one file
- S: < 150 lines, 1–2 files
- M: < 400 lines, 2–3 files
- L: > 400 lines, multiple files

## Completed

| #                  | Feature                                  | Tests                        |
| ------------------ | ---------------------------------------- | ---------------------------- |
| [1](issues/1.md)   | do-while loops                           | 2 in control-flow.test.ts    |
| [2](issues/2.md)   | switch statements                        | 3 in control-flow.test.ts    |
| [3](issues/3.md)   | Arrays                                   | 5 in arrays-enums.test.ts    |
| [4](issues/4.md)   | for-of loops                             | 2 in control-flow.test.ts    |
| [5](issues/5.md)   | Enums                                    | 4 in arrays-enums.test.ts    |
| [6](issues/6.md)   | Classes                                  | in codegen (needs test file) |
| [7](issues/7.md)   | Closures / arrow functions               | in codegen (needs test file) |
| [8](issues/8.md)   | Generics                                 | 5 in generics.test.ts        |
| [9](issues/9.md)   | for-in loops                             | —                            |
| [10](issues/10.md) | DOM support                              | —                            |
| [11](issues/11.md) | Arrow function callbacks                 | —                            |
| [12](issues/12.md) | VS Code-like IDE layout for playground   | —                            |
| [13](issues/13.md) | Template literals (substitutions)        | —                            |
| [14](issues/14.md) | String methods                           | —                            |
| [15](issues/15.md) | Ternary / conditional expression         | —                            |
| [16](issues/16.md) | Optional chaining and nullish coalescing | —                            |
| [17](issues/17.md) | Destructuring                            | —                            |
| [23](issues/23.md) | Bitwise operators                        | 14 in bitwise.test.ts        |
| [24](issues/24.md) | Exponentiation operator                  | 1 in equivalence.test.ts     |
| [25](issues/25.md) | Fix f32.const opcode in binary emitter   | —                            |
| [26](issues/26.md) | Array methods via host imports           | 22 in array-methods.test.ts  |
| [29](issues/29.md) | Investigate failing tests                | fixed 2 in import-resolver   |
| [18](issues/18.md) | Spread and rest operators                | 13 in spread-rest.test.ts    |
| [19](issues/19.md) | Type narrowing and union types           | 4 in union-narrowing.test.ts |
| [27](issues/27.md) | Try/catch/throw                          | 8 in try-catch.test.ts       |
| [28](issues/28.md) | Multi-file module compilation            | 10 in multi-file.test.ts     |
| [30](issues/30.md) | Async/await and Promises                 | 8 in async-await.test.ts     |
