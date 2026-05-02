---
id: 387
title: "Unsupported call expression (2356 CE)"
status: done
created: 2026-03-16
updated: 2026-04-14
completed: 2026-04-14
priority: high
feasibility: hard
goal: core-semantics
test262_ce: 2356
files:
  src/codegen/expressions.ts:
    new:
      - "compileCallExpression — handle calls in destructuring contexts, class bodies, generators"
    breaking: []
---
# #387 — Unsupported call expression (2356 CE)

## Status: open

2356 tests fail with "Unsupported call expression" (updated 2026-03-16 from latest test262 run). Root cause breakdown:

| Context | Count | % |
|---------|------:|---|
| Destructuring | 829 | 71% |
| Class body | 188 | 16% |
| String built-in methods | 54 | 5% |
| Generator | 54 | 5% |
| Other | 40 | 3% |

## Details

The compiler rejects call expressions in certain code positions:

**Destructuring (829)**: Calls used as initializers or within destructuring patterns:
```javascript
let [a = fn()] = arr;
let { x = getDefault() } = obj;
```

**Class body (188)**: Calls in class method signatures, decorators, computed property names:
```javascript
class C { [Symbol.iterator]() {} }
```

**String methods (54)**: Built-in string methods like split, match, search not recognized as valid call targets.

## Complexity: L

## Acceptance criteria
- [ ] Call expressions in destructuring default values compile
- [ ] Calls in class computed property names compile
- [ ] Reduce "Unsupported call expression" CEs by 500+
