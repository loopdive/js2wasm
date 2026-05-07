---
id: 1332
sprint: 50
title: "RegExp host-mode: prototype method edge cases (exec, test, flag accessors, RegExpStringIterator)"
status: ready
created: 2026-05-08
updated: 2026-05-08
priority: low
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: runtime
language_feature: regexp
goal: spec-completeness
parent: 1002
---
# #1332 — RegExp host-mode: prototype method edge cases

Carved out of #1002 (RegExp js-host mode). Catches the long-tail prototype method failures that aren't part of the four Symbol protocols.

## Problem

84 test262 failures across:
- 27 `RegExp.prototype.exec` edge cases
- 16 `RegExp.prototype.test` edge cases
- 24 `RegExp.prototype` flag/source accessors (flags, global, ignoreCase, unicode, sticky, dotAll, multiline, hasIndices, source)
- 17 `RegExpStringIterator` prototype tests

## Sample failures

- `built-ins/RegExp/prototype/exec/S15.10.6.2_A2_T7.js`
- `built-ins/RegExp/prototype/exec/failure-lastindex-access.js`
- `built-ins/RegExp/prototype/test/S15.10.6.3_A1_T8.js`
- `built-ins/RegExp/prototype/flags/coercion-global.js`
- `built-ins/RegExp/prototype/unicode/cross-realm.js`
- `built-ins/RegExpStringIteratorPrototype/ancestry.js`

## Spec references

- §22.2.6.2 RegExp.prototype.exec
- §22.2.6.16 RegExp.prototype.test
- §22.2.6.4 / 6.5 / etc. flag accessors
- §22.2.9 RegExpStringIterator

## Approach

Mostly host-wrapper coercion / `this` binding / cross-realm semantics. Not as deep as the Symbol protocols but spec-edge-case-heavy.

## Acceptance criteria

- 60+ of 84 flip to pass
- Remaining ones documented

## Related

- Parent #1002 (closed-as-scoped)

## Implementation Plan

### Root cause (four sub-buckets)

This bucket has four distinct failure shapes; each has its own remedy. All four go through the host-mode bridge at `src/runtime.ts:1610-1617` (`extern_class` `method` action: `self[m]?.call(self, ...args)`), which is correct *as long as* the dispatch reaches it with the right receiver and arg types.

**(a) `RegExp.prototype.exec` / `.test` brand check (~30 of 84 fails)** — Tests like `RegExp.prototype.exec.call(non_regex_obj, str)` and `failure-lastindex-access.js` invoke the method on a non-RegExp `this`. The compiler currently routes `regex.exec(...)` via `compileExternMethodCall` (`src/codegen/expressions/extern.ts:39-105`), which calls the host import `RegExp_exec(this, str)`. The runtime's intent handler for `extern_class` `method` (line 1610) does `self["exec"].call(self, ...args)` — but **only if `self` has a method named "exec"**; otherwise it returns `undefined`. For receiver = `RegExp.prototype` (no own `exec`), this crashes.

Fix: in the `extern_class` `method` handler (line 1611-1617), when `fn` is missing, fall back to walking `Object.getPrototypeOf(self)` until a method is found, OR — preferred — when the static type at the call site is `RegExp.prototype` / `RegExp` and the method exists on `RegExp.prototype`, emit `__proto_method_call("RegExp", "exec", self, args)` instead of `RegExp_exec(self, ...args)`. The `__proto_method_call` import already exists (`src/runtime.ts:2947-2983`) and does exactly this for Array.prototype.

**(b) Flag accessors via `.call` (~20 fails)** — Tests like `RegExp.prototype.flags.call(rx)` access getters declared on `RegExp.prototype`. Currently, getter access on extern classes routes to the auto-registered `RegExp_get_flags(self)` import (`src/codegen/index.ts:6633`). The host runtime's `extern_class` `get` handler at `src/runtime.ts:1602-1605` does `_safeGet(self, "flags")` which returns the value, but invoking `.call(rx)` on the *value* of the getter doesn't make sense — these tests want the **getter function itself** from the prototype, then call it with a receiver.

Fix: Codegen — when the receiver of a property access is `RegExp.prototype` (or any built-in's `.prototype`), do not route to `${prefix}_get_${name}`; instead emit `__extern_get(__get_builtin("RegExp").prototype, "<name>")` so the host returns the bound getter descriptor. The `BUILTIN_CTOR_NAMES` path in `src/codegen/property-access.ts:986-1066` already does this for `BuiltIn.prop`; extend it (or add a sibling path at line ~1716) to detect `BuiltIn.prototype.<member>` and use `__extern_get` rather than the typed extern-class import.

**(c) Coercion edge cases on `.exec` / `.test` (~15 fails)** — `regex.exec(undefined)` should call `exec(String(undefined))` ("undefined" → match attempt), `regex.test({toString:…})` should ToString-coerce the arg. The current `extern_class` method handler at `src/runtime.ts:1611-1617` does no coercion — it passes `args` straight through. V8 itself ToStrings the arg, so this *should* work; the failure is upstream: the compiler passes a wasmGC string struct as the arg, and V8's `String(struct)` returns `"[object Object]"` instead of invoking the wasmGC closure-field `toString`. The pattern in `string_method` (line 1506-1523) handles this via `_toPrimitive`/`_hostToPrimitive`; mirror that here.

Fix: in `src/runtime.ts` `extern_class` `method` handler (line 1610), wrap each arg through `_isWasmStruct(a) ? _wrapForHost(a, exports) : a` (same pattern used by `__extern_method_call` at line 2851). This makes wasmGC structs with closure `toString`/`valueOf` work transparently.

**(d) RegExpStringIterator prototype chain (17 fails)** — `Object.getPrototypeOf(/./[Symbol.matchAll]('a'))` must return the `%RegExpStringIteratorPrototype%`, whose proto is `%IteratorPrototype%` (§22.2.9). The compiler likely returns an externref iterator from `RegExp_get_matchAll` or similar, but `Object.getPrototypeOf` on that externref isn't routed through the host. Tests in `RegExpStringIteratorPrototype/next/*` exercise iterator next-value semantics; V8 handles them correctly *if* `getPrototypeOf` reaches V8.

Fix: nothing dedicated. `Object.getPrototypeOf` on an externref already routes through `__object_getPrototypeOf` (verify in `src/codegen/expressions/calls.ts`); if not, register it. Spot-check `ancestry.js`, `Symbol.toStringTag.js`, `next/iterating-empty-pattern.js` after fixes (a)+(b) land — most should auto-flip.

### Changes summary

| Sub-bucket | File | Function | Change |
|---|---|---|---|
| (a) | `src/runtime.ts` | `extern_class` `method` handler (line 1610) | Walk prototype chain when direct method missing |
| (a) | `src/codegen/expressions/extern.ts` | `compileExternMethodCall` (line 39) | When receiver is `Class.prototype`, route via `__proto_method_call` |
| (b) | `src/codegen/property-access.ts` | builtin-ctor path (line 986-1066) | Extend to `BuiltIn.prototype.<member>` |
| (c) | `src/runtime.ts` | `extern_class` `method` handler (line 1610-1617) | Wrap wasmGC struct args via `_wrapForHost` (mirror `__extern_method_call` at line 2851) |
| (d) | depends on (a)+(b) | (verification only) | Re-run after a/b/c |

### Spec references
- §22.2.6.2 (exec) — V8 implements; we just need dispatch.
- §22.2.6.16 (test) — ditto.
- §22.2.6.4-12 (flag accessors) — V8 implements; we need the *getter* from the prototype.
- §22.2.9.1 RegExpStringIterator — V8 implements; we need `Object.getPrototypeOf` to reach it.

### Test files to verify
- `tests/equivalence/regexp-methods.test.ts` — add: `RegExp.prototype.exec.call(/a/, "ab")` returns array; `Object.getOwnPropertyDescriptor(RegExp.prototype, "flags").get` is a function.
- Re-run test262: `built-ins/RegExp/prototype/exec/*`, `built-ins/RegExp/prototype/test/*`, `built-ins/RegExp/prototype/flags/*` (and the per-flag accessor dirs), `built-ins/RegExpStringIteratorPrototype/*`.
