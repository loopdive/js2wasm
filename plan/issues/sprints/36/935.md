---
id: 935
title: "Add String.fromCodePoint() static method"
status: done
created: 2026-04-03
updated: 2026-04-14
completed: 2026-04-14
priority: low
feasibility: easy
reasoning_effort: medium
goal: standalone-mode
required_by: [940]
tags: [good-first-issue, codegen, string]
files:
  src/codegen/expressions.ts:
    modify:
      - "Add String.fromCodePoint handling next to existing String.fromCharCode"
  src/codegen/index.ts:
    modify:
      - "Register host import for String_fromCodePoint in collectStringStaticImports"
---
# #935 -- Add `String.fromCodePoint()` static method

## Problem

The compiler supports `String.fromCharCode(code)` but not `String.fromCodePoint(code)`. `String.fromCodePoint` is the modern replacement that handles code points above U+FFFF (e.g., emoji).

Currently, code like `String.fromCodePoint(128512)` fails to compile or falls through to generic call handling.

## What to change

### 1. Register the host import (`src/codegen/index.ts`)

Find the `collectStringStaticImports` function (around line 7802). It currently scans for `String.fromCharCode` calls and registers a host import. Add the same pattern for `String.fromCodePoint`:

```typescript
// Inside the visitor, after the fromCharCode check:
if (propAccess.name.text === "fromCodePoint") {
  needsFromCodePoint = true;
}
```

Then register the import with the same signature as `String_fromCharCode`: `(f64) -> externref`.

### 2. Compile the call (`src/codegen/expressions.ts`)

Find the `String.fromCharCode` handling (around line 9431). Add a parallel block for `String.fromCodePoint`:

```typescript
if (
  propAccess.name.text === "fromCodePoint" &&
  expr.arguments.length >= 1
) {
  const funcIdx = ctx.funcMap.get("String_fromCodePoint");
  if (funcIdx !== undefined) {
    compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "f64" });
    fctx.body.push({ op: "call", funcIdx });
    return stringType(ctx);
  }
}
```

### 3. Add the runtime host function (`src/runtime.ts`)

In `buildImports`, find where `String_fromCharCode` is defined. Add:

```typescript
String_fromCodePoint: (code: number) => String.fromCodePoint(code),
```

## Testing

Create `tests/issue-935.test.ts`:

```typescript
import { compile } from '../src/index';
// Test: String.fromCodePoint(65) should return "A"
// Test: String.fromCodePoint(128512) should return "😀"
```

## Scope boundary

- Only handle the single-argument form: `String.fromCodePoint(n)`
- Multi-argument `String.fromCodePoint(a, b, c)` is out of scope
- Do NOT modify string-ops.ts or the native string backend

## Acceptance criteria

- [ ] `String.fromCodePoint(65)` compiles and returns `"A"` at runtime
- [ ] `String.fromCodePoint(128512)` compiles and returns the correct emoji
- [ ] Existing `String.fromCharCode` tests still pass
