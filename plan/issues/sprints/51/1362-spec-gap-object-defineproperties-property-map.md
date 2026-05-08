---
id: 1362
sprint: 51
title: "spec gap: Object.defineProperties — apply full descriptor map (332 fails)"
status: done
created: 2026-05-08
priority: high
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen, runtime
language_feature: object
goal: spec-completeness
---
# #1362 — Object.defineProperties: full descriptor map application

## Problem

`built-ins/Object/defineProperties` — **332 fails**. Sibling to #1334 (defineProperty
single-descriptor fidelity) but distinct surface: applies a *map* of descriptors to one
object in a single call.

Sample failures:

- `defineProperties/15.2.3.7-5-a-1.js` — TypeError when `Properties` is undefined.
- `defineProperties/15.2.3.7-6-a-1.js` — own enumerable keys only (skip inherited).
- `defineProperties/15.2.3.7-2-1.js` — `O` must be Object (TypeError on null/primitive).
- `defineProperties/throw-getter-second-prop.js` — abrupt completion on second
  descriptor's getter; first one already applied? spec says all-or-nothing.

Spec §20.1.2.3 algorithm:

1. If `Type(O)` is not Object → TypeError.
2. `props = ToObject(Properties)`.
3. `keys = props.[[OwnPropertyKeys]]()` (string + symbol; both!).
4. For each key, if its descriptor on `props` is enumerable: read descriptor, validate.
5. Two-phase commit: collect ALL descriptors first (this can throw); only then apply
   them in order. If any read throws, no writes happen.

The current implementation forwards to `__object_defineProperties` (host import), which:
- Skips symbol keys (only iterates `Object.keys`).
- Doesn't validate `props` type.
- Silently writes partial state when an enumerable getter throws midway.

## Acceptance criteria

1. `built-ins/Object/defineProperties/15.2.3.7-2-1.js` passes (Type(O) check).
2. `built-ins/Object/defineProperties/15.2.3.7-5-a-1.js` passes (undefined props → TypeError).
3. `built-ins/Object/defineProperties/15.2.3.7-6-a-2.js` passes (Symbol-keyed props).
4. `built-ins/Object/defineProperties/throw-getter-second-prop.js` passes (all-or-nothing).
5. Pass-rate for `built-ins/Object/defineProperties` rises from ~10% to ≥80%;
   **+250 net passes**.

## Files to modify

- `src/codegen/object-ops.ts` — `compileObjectDefineProperties`.
- `src/runtime.ts` — `__object_defineProperties` host import; rewrite to spec.
- (Optional) `src/codegen/expressions.ts` — `Object.defineProperty` callsite, share validator.

## Implementation Plan

### Root cause

The host import does the simplest possible loop:
```js
for (const k of Object.keys(props)) {
  Object.defineProperty(o, k, props[k]);
}
```
This breaks on:
- `Object.keys` returns no symbols.
- No two-phase commit — first failed descriptor leaves earlier descriptors applied.
- No type-checks on inputs.

### Approach

Rewrite `__object_defineProperties` in `src/runtime.ts` per spec:

```ts
__object_defineProperties(O, Properties) {
  if (O === null || (typeof O !== 'object' && typeof O !== 'function')) {
    throw new TypeError("Object.defineProperties called on non-object");
  }
  const props = Object(Properties);  // ToObject; throws on null/undefined.
  const keys = Reflect.ownKeys(props);  // includes Symbol keys.

  // Phase 1: collect descriptors (can throw mid-way).
  const descriptors = [];
  for (const key of keys) {
    const desc = Reflect.getOwnPropertyDescriptor(props, key);
    if (desc && desc.enumerable) {
      const descObj = props[key];  // may invoke getter, may throw
      // ToPropertyDescriptor §6.2.6.5
      const propDesc = toPropertyDescriptor(descObj);
      descriptors.push([key, propDesc]);
    }
  }

  // Phase 2: apply.
  for (const [key, propDesc] of descriptors) {
    Object.defineProperty(O, key, propDesc);
  }
  return O;
}
```

Note: per spec §20.1.2.3 step 5, the loop is actually combined — Phase 1 reads all
descriptors first; if any read throws, the spec says abrupt completion is returned
*before* any writes. But test262's `throw-getter-second-prop.js` checks exactly this.

Verify the helper `toPropertyDescriptor` is exposed (it's spec §6.2.6.5; reuse the
helper added by #1334).

### Edge cases

- `defineProperties(o, undefined)` → `Object(undefined)` = `{}`, but spec actually
  has `RequireObjectCoercible` first — must throw TypeError. Add explicit check:
  `if (Properties === null || Properties === undefined) throw TypeError`.
- `defineProperties(o, "abc")` → `Object("abc")` is a String box; ownKeys = `["length", "0", "1", "2"]`. Each property's descriptor has `enumerable: true` for the chars but not length; the chars become defined on `o`. Spec-correct.
- Symbol keys mix with string keys — order: spec says "in same order as
  `[[OwnPropertyKeys]]()`": integer indices ascending, then strings in insertion
  order, then symbols in insertion order. `Reflect.ownKeys` honors that.

### Test262 sample

- `test262/test/built-ins/Object/defineProperties/15.2.3.7-2-1.js`
- `test262/test/built-ins/Object/defineProperties/15.2.3.7-5-a-1.js`
- `test262/test/built-ins/Object/defineProperties/15.2.3.7-6-a-2.js`
- `test262/test/built-ins/Object/defineProperties/throw-getter-second-prop.js`
- `test262/test/built-ins/Object/defineProperties/throw-key-error.js`

### Estimated impact

+250 net passes; tied to the same descriptor-fidelity work as #1334 (same runtime
helper).
