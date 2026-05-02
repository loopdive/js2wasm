---
id: 39
title: "Issue 39: Labeled Break and Continue"
status: done
created: 2026-03-01
updated: 2026-04-14
completed: 2026-03-01
goal: builtin-methods
---
# Issue 39: Labeled Break and Continue

## Status: done

## Summary
Support labeled statements with `break label` and `continue label` for targeting specific outer loops.

## Motivation
Labeled break/continue is needed for nested loop algorithms. Currently `break`/`continue` exist but ignore labels.

## Design

### Wasm Block Structure
Labels map to Wasm block depth calculations:

```typescript
outer: for (...) {
  inner: for (...) {
    break outer;    // br with depth targeting the outer block
    continue outer; // br targeting the outer loop header
  }
}
```

### Implementation
1. Add `labelMap: Map<string, { breakDepth: number, continueDepth: number }>` to function context
2. `LabeledStatement`: record label name with current block depths, compile inner statement, remove label
3. `break label` / `continue label`: look up label in map, calculate relative depth, emit `br`

## Scope
- `src/codegen/statements.ts` — handle `LabeledStatement`, labeled break/continue (~60 lines)
- `src/codegen/index.ts` — add `labelMap` to function context (~5 lines)
- `tests/labeled-loops.test.ts` (~60 lines)

## Complexity: S

## Acceptance criteria
- `label: for (...)` compiles with named block targets
- `break label` exits the labeled loop
- `continue label` jumps to the labeled loop's next iteration
- Works with multiple nesting levels
- Unlabeled break/continue still work as before
- All existing tests still pass
