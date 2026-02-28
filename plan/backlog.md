# ts2wasm Backlog

## Open issues

| # | Feature | Complexity | Depends on |
|---|---------|------------|------------|
| [23](issues/23.md) | Bitwise operators | S | — |
| [24](issues/24.md) | Exponentiation operator | XS | — |
| [25](issues/25.md) | Fix f32.const opcode in binary emitter | XS | — |
| [29](issues/29.md) | Investigate failing tests | XS–S | — |
| [6](issues/6.md) | Classes | L | — |
| [7](issues/7.md) | Closures / arrow functions | L | — |
| [8](issues/8.md) | Generics | L | — |
| [26](issues/26.md) | Array methods via host imports | M/L | #7 for callbacks |
| [18](issues/18.md) | Spread and rest operators | L | — |
| [19](issues/19.md) | Type narrowing and union types | L | — |
| [27](issues/27.md) | Try/catch/throw | L | — |
| [28](issues/28.md) | Multi-file module compilation | L | — |
| [30](issues/30.md) | Async/await and Promises | L | — |

## Complexity legend
- XS: < 50 lines, one file
- S: < 150 lines, 1–2 files
- M: < 400 lines, 2–3 files
- L: > 400 lines, multiple files

## Completed

| # | Feature | Tests |
|---|---------|-------|
| [1](issues/1.md) | do-while loops | 2 in control-flow.test.ts |
| [2](issues/2.md) | switch statements | 3 in control-flow.test.ts |
| [3](issues/3.md) | Arrays | 5 in arrays-enums.test.ts |
| [4](issues/4.md) | for-of loops | 2 in control-flow.test.ts |
| [5](issues/5.md) | Enums | 4 in arrays-enums.test.ts |
| [9](issues/9.md) | for-in loops | — |
| [10](issues/10.md) | DOM support | — |
| [11](issues/11.md) | Arrow function callbacks | — |
| [12](issues/12.md) | VS Code-like IDE layout for playground | — |
| [13](issues/13.md) | Template literals (substitutions) | — |
| [14](issues/14.md) | String methods | — |
| [15](issues/15.md) | Ternary / conditional expression | — |
| [16](issues/16.md) | Optional chaining and nullish coalescing | — |
| [17](issues/17.md) | Destructuring | — |
