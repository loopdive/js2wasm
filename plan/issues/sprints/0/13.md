---
id: 13
title: "Issue 13: Template Literals"
status: done
created: 2026-02-28
updated: 2026-04-14
completed: 2026-02-28
goal: builtin-methods
---
# Issue 13: Template Literals

## Status: done

## Summary
Support template literal expressions: `` `hello ${name}, result is ${fib(10)}` ``

## Motivation
Template literals are the idiomatic way to build strings in TypeScript. Without them, users must chain `+` and `.toString()` calls manually.

## Design

### Approach: Desugar to string concatenation
At compile time, lower template literals to a chain of `concat` calls:

```ts
`fib(${n}) = ${fib(n)}`
// becomes:
"fib(" + n.toString() + ") = " + fib(n).toString()
```

### Implementation
In `compileExpressionInner`, handle `ts.isTemplateExpression(expr)`:
1. Start with the head text as a string literal
2. For each template span:
   - Compile the expression
   - If result is f64, call `number_toString`; if i32, convert to f64 first then call; if externref, use as-is (assumed string)
   - Call `concat` with the accumulated string
   - Append the span's literal text via another `concat`

Also handle `ts.isNoSubstitutionTemplateLiteral` (backtick strings with no `${}`) — treat as plain string literal.

## Scope
- `src/codegen/expressions.ts`: handle TemplateExpression and NoSubstitutionTemplateLiteral
- Depends on: string imports (concat), number_toString

## Complexity: S

## Acceptance criteria
- `` `hello ${name}` `` compiles and produces correct string at runtime
- `` `result: ${fib(10)}` `` auto-converts number to string
- No-substitution template literals (`` `plain text` ``) work as string literals
