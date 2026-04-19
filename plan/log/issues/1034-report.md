# #1034 Prettier Stress Report

Generated: 2026-04-11T18:58:36.615Z
Prettier version: 3.8.1 (pre-bundled ESM)

## Summary

| Entry | Tier | Compile | Instantiate | Errors | Binary |
|---|---|---|---|---|---|
| `prettier/doc.mjs` | Tier 2 (doc printer) | OK | FAIL | 15 | 107858B |
| `prettier/index.mjs` | Tier 1+3+4 (core + language-js) | FAIL | — | 4 | 0B |

## prettier/doc.mjs — Tier 2 (doc printer)

- Compile success: **true**
- Binary size: 107858B
- Instantiates: **false**
- Instantiate error: `WebAssembly.instantiate(): Compiling function #55:"trimNewlinesEnd" failed: call[0] expected type externref, found call of type f64 @+40428`
- Diagnostic count: 15
- First error: `Unsupported new expression for class: ListFormat`

### Buckets
- **codegen: object literal → struct inference**: 11
- **codegen: new Intl/builtin class**: 2
- **codegen: for-of non-array iterable**: 2

### All errors
```
Unsupported new expression for class: ListFormat
for-of requires an array expression
Object literal type not mapped to struct
Object literal type not mapped to struct
Object literal type not mapped to struct
Object literal type not mapped to struct
Cannot determine struct type for object literal
Cannot determine struct type for object literal
Cannot determine struct type for object literal
Object literal type not mapped to struct
Cannot determine struct type for object literal
Cannot determine struct type for object literal
Cannot determine struct type for object literal
Unsupported new expression for class: ListFormat
for-of requires an array expression
```

## prettier/index.mjs — Tier 1+3+4 (core + language-js)

- Compile success: **false**
- Binary size: 0B
- Instantiates: **false**
- Diagnostic count: 4
- First error: `'await' is not allowed as a label identifier in this context`

### Buckets
- **parser: await as label identifier**: 4

### All errors
```
'await' is not allowed as a label identifier in this context
'await' is not allowed as a label identifier in this context
'await' is not allowed as a label identifier in this context
'await' is not allowed as a label identifier in this context
```
