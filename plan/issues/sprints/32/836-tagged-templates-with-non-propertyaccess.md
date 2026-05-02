---
id: 836
title: "Tagged templates with non-PropertyAccess tag expressions (20 CE)"
status: done
created: 2026-03-28
updated: 2026-04-14
completed: 2026-04-14
priority: low
feasibility: easy
goal: ci-hardening
test262_ce: 20
---
# #836 -- Tagged templates with non-PropertyAccess tag expressions (20 CE)

## Problem

20 tests fail with tagged template compile errors. The compiler only handles tagged templates where the tag is a `PropertyAccessExpression` (e.g. `String.raw\`...\``). When the tag is a `CallExpression` or plain `Identifier`, compilation fails.

## Breakdown by tag kind

| Tag kind | Count | Example |
|----------|-------|---------|
| CallExpression | ~8 | `(function() { return fn; })()\`...\`` |
| Identifier | ~12 | `tag\`...\``, `await\`...\`` |

## Sample files with exact errors

### 1. CallExpression tag

**File**: `test/language/expressions/tagged-template/call-expression-argument-list-evaluation.js`
**Error**: `L20:1 Tagged template: unsupported tag expression kind CallExpression; L30:1 Tagged template: unsupported tag expression kind CallExpression`
**Source** (lines 20-26):
```js
(function() {
  return function() {
    calls++;
    assert.sameValue(
      arguments.length, 1, 'NoSubstitutionTemplate arguments length'
    );
  };
})()`NoSubstitutionTemplate`;
```

### 2. CallExpression tag (tail call)

**File**: `test/language/expressions/tagged-template/tco-call.js`
**Error**: `L21:12 Tagged template: unsupported tag expression kind CallExpression`

### 3. Identifier tag

**File**: `test/language/expressions/tagged-template/tco-member.js`
**Error**: `L18:12 Tagged template: unsupported tag expression kind Identifier`

### 4. Identifier tag in module context

**File**: `test/language/module-code/top-level-await/syntax/block-await-expr-template-literal.js`
**Error**: `L59:35 Tagged template: unsupported tag expression kind Identifier`
**Source** (line 59):
```js
result = tag`hello ${await 'world'}`;
```

### 5. Multiple Identifier tags

**File**: `test/language/module-code/top-level-await/syntax/export-var-await-expr-template-literal.js`
**Error**: `L63:20 Tagged template: unsupported tag expression kind Identifier; L64:18 Tagged template: unsupported tag expression kind Identifier`

## Root cause

In `src/codegen/expressions.ts`, the tagged template compilation only handles `PropertyAccessExpression` tags. It needs to be extended to:

1. **Identifier tags**: Look up the identifier as a function and call it with template args
2. **CallExpression tags**: Compile the call expression to get the function, then call it with template args

## Acceptance criteria

- Tagged templates with Identifier and CallExpression tags compile
- 20 compile errors eliminated

## Test Results

All 29 tagged template test262 tests (in `test/language/expressions/tagged-template/`) compile without tagged template CE errors (was ~20 CE before fix). All 5 sample tests from the issue compile successfully.

Equivalence tests: 998 passed / 226 failed (no change from baseline).
