---
id: 1333
sprint: 50
title: "RegExp host-mode: Pre-ES6 (S15.10) tests + annexB legacy accessors"
status: ready
created: 2026-05-08
updated: 2026-05-08
priority: low
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: runtime
language_feature: regexp
goal: spec-completeness
parent: 1002
---
# #1333 — RegExp host-mode: Pre-ES6 (S15.10) tests + annexB legacy accessors

Carved out of #1002 (RegExp js-host mode).

## Problem

86 test262 failures across:
- 69 Pre-ES6 (S15.10) RegExp tests — legacy spec test names targeting older RegExp behavior
- 17 annexB legacy accessors — `RegExp.input` / `RegExp.lastMatch` / `RegExp.leftContext` / `RegExp.rightContext` / `RegExp.lastParen` / `RegExp.$1`–`$9`

## Sample failures

- `built-ins/RegExp/S15.10.2.7_A4_T2.js` (and 68 sibling S15.10.* tests)
- `annexB/built-ins/RegExp/legacy-accessors/input/this-cross-realm-constructor.js`
- `annexB/built-ins/RegExp/legacy-accessors/lastMatch/...`

## Approach

Two distinct sub-issues:

**(a) Pre-ES6 (S15.10) tests** — likely all share the same root cause(s). Sample one and trace; many will cluster onto one or two underlying gaps (e.g., constructor argument coercion, source-property quoting, flags string ordering).

**(b) annexB legacy accessors** — these are pre-RegExp-ES6 globals (`RegExp.$1` etc.) that point to the last-matched groups. Implementing them requires the host-wrapper to update a hidden global slot after every match. This is annexB (browser-only legacy), so explicit *non*-implementation may be acceptable per acceptance.

## Acceptance criteria

- Either implement, or document as wont-fix (annexB legacy)
- Pre-ES6 cluster: 50+ flip to pass

## Related

- Parent #1002 (closed-as-scoped)

## Implementation Plan

### Triage decision (read first)

This bucket is a grab-bag — *do not try to land all 86 in one PR*. Treat each sub-cluster separately:

| Sub-cluster | Count | Recommendation |
|---|---|---|
| (a) S15.10.1 syntax-error tests (`a**`, `a***`, etc.) | ~16 | Investigate first — should already pass via V8's `RegExp_new` SyntaxError + Wasm exception bridge. If they fail, file a new issue against the exception-tag bridge. |
| (b) S15.10.2.* exec-result tests | ~40 | Mostly blocked on **externref-vs-wasmGC equivalence**, not RegExp semantics. Defer to a new issue (`regexp-exec-result-equivalence`). |
| (c) S15.10.6 prototype/methods (toString, source) | ~13 | Should auto-flip once #1332(b) (flag/source accessor routing) lands. Verify only. |
| (d) annexB `RegExp.input` / `$_` / `$1`-`$9` / `lastMatch` etc. | 17 | **Implement** in `src/runtime.ts` — see (d) below. Per-stakeholder: do NOT wont-fix. |

### (a) S15.10.1 syntax-error cluster — verify, don't reimplement

Sample test (`S15.10.1_A1_T1.js`): `new RegExp("a**")` must throw `SyntaxError`. The compiler emits `RegExp_new(pattern, flags)` via the on-demand path (`src/codegen/typeof-delete.ts:172-180` for literals, `src/codegen/expressions/calls.ts:402-419` for `new RegExp(...)` calls). The host runtime at `src/runtime.ts:1593-1600` calls `new RegExp(...args)`, V8 throws `SyntaxError` with the right prototype.

**Likely failure mode**: Wasm-thrown exception isn't recognized as `SyntaxError` instance via `instanceof` because it crosses the host→wasm exception bridge with the wrong tag. **Verify before specing**: dev should compile and run two of these locally; if pass on local, mark them as test-262-runner cache misses; if fail, file a new bug against the exception-tag bridge (`addExceptionImports` in `src/codegen/index.ts`) — not in this issue.

### (b) S15.10.2.* exec-result cluster — defer

Sample test (`S15.10.2.7_A1_T1.js`): mixes V8-returned exec result (externref array with `.index`/`.input`/numbered slots) with wasmGC `__expected = ["42"]; __expected.index = 14` then compares element-by-element via `assert.sameValue`. The cross-realm comparison between an externref string element and a wasmGC string struct fails strict-equality in the host bridge.

**Recommendation**: do **not** spec a fix here. Open a separate issue `regexp-exec-result-equivalence` with title "WasmGC string struct ≠ V8 string in strict equality" and link it to the spec audit (#1334). The fix is broad — `__host_eq` (`src/runtime.ts:121` import-manifest entry) needs to extend to compare a wasmGC string struct against an externref string by content. That work belongs in the string-equivalence track, not in this RegExp bucket.

### (c) S15.10.6.* prototype-method cluster — verify after #1332

Sample test (`S15.10.6.4_A1_T1.js`-style): `RegExp.prototype.toString.call(/a/g)` returns `"/a/g"`. Once #1332(b) routes `RegExp.prototype.<accessor>` through `__extern_get(RegExp.prototype, "<name>")`, V8 returns the real prototype function; `.call(/a/g)` reaches V8 and produces the spec-correct string. **Action**: dev re-runs this bucket after #1332 merges; expects auto-pass on most.

### (d) annexB legacy accessors — implement in src/runtime.ts (REVISED — no wont-fix)

Spec: **Annex B §B.2.2** "Additional Properties of the RegExp Object". Tests: `annexB/built-ins/RegExp/legacy-accessors/{input,$_,lastMatch,$&,leftContext,$\`,rightContext,$',lastParen,$+,$1..$9}/`.

**Per stakeholder direction**: do NOT rely on V8's native annexB. Implement these accessors directly in `src/runtime.ts` so behavior is deterministic across host runtimes and the path is forward-compatible with standalone (non-V8) hosts. V8's own annexB implementation is overridden by ours via `Object.defineProperty` at runtime init.

#### Spec algorithm (Annex B §B.2.2.1.1 GetLegacyRegExpStaticProperty)

```
GetLegacyRegExpStaticProperty(C, thisValue, internalSlotName)
  1. Assert: C is an object that has an internal slot named internalSlotName.
  2. If SameValue(C, thisValue) is false, throw TypeError.
  3. Let val be the value of the internal slot of C named internalSlotName.
  4. If val is empty, throw TypeError.
  5. Return val.

SetLegacyRegExpStaticProperty(C, thisValue, internalSlotName, val)  -- only for [[RegExpInput]]
  1. Assert: C is an object that has an internal slot named internalSlotName.
  2. If SameValue(C, thisValue) is false, throw TypeError.
  3. Let strVal be ? ToString(val).
  4. Set the value of C's internal slot to strVal.
  5. Return undefined.
```

The internal slots tracked on `%RegExp%`:
- `[[RegExpInput]]` — last input string (writable via `RegExp.input = ...`)
- `[[RegExpLastMatch]]` — full last match
- `[[RegExpLastParen]]` — last captured group's value (or `""`)
- `[[RegExpLeftContext]]` — substring of input before the match
- `[[RegExpRightContext]]` — substring of input after the match
- `[[RegExpParen1]]` … `[[RegExpParen9]]` — captures 1..9 (`""` when missing)

Updated by **RegExpBuiltinExec** (§22.2.7.2) after every successful match.

#### Changes to `src/runtime.ts`

**1. Add module-level `_legacyRegExpState`** (near `_symbolToWasm` definitions, ~line 770):

```typescript
/** Annex B §B.2.2 internal slots on %RegExp%. Updated after every successful
 *  RegExpBuiltinExec; read via the legacy accessor getters defined in
 *  _installLegacyRegExpAccessors. */
type LegacyRegExpState = {
  input: string;          // [[RegExpInput]]
  lastMatch: string;      // [[RegExpLastMatch]]
  lastParen: string;      // [[RegExpLastParen]]
  leftContext: string;    // [[RegExpLeftContext]]
  rightContext: string;   // [[RegExpRightContext]]
  parens: string[];       // [[RegExpParen1..9]] — length 9, "" for missing
};
const _legacyRegExpState: LegacyRegExpState = {
  input: "",
  lastMatch: "",
  lastParen: "",
  leftContext: "",
  rightContext: "",
  parens: ["", "", "", "", "", "", "", "", ""],
};
```

**2. Add `_updateLegacyRegExpState(input, matchResult)` helper:**

```typescript
/** Called from RegExp_exec, RegExp_test, string_match, string_search, etc.
 *  whenever V8 returns a non-null match array. Mirrors RegExpBuiltinExec
 *  step 25-26 (the spec hook that updates the legacy slots). */
function _updateLegacyRegExpState(input: string, m: RegExpExecArray | RegExpMatchArray | null): void {
  if (m == null) return;  // null match leaves the slots untouched (per spec)
  const idx = m.index ?? 0;
  const matchStr = m[0] ?? "";
  _legacyRegExpState.input = input;
  _legacyRegExpState.lastMatch = matchStr;
  _legacyRegExpState.leftContext = input.substring(0, idx);
  _legacyRegExpState.rightContext = input.substring(idx + matchStr.length);
  // Capture groups
  let lastNonEmptyParen = "";
  for (let i = 0; i < 9; i++) {
    const cap = m[i + 1];
    const v = cap == null ? "" : String(cap);
    _legacyRegExpState.parens[i] = v;
    if (cap != null) lastNonEmptyParen = v;
  }
  _legacyRegExpState.lastParen = lastNonEmptyParen;
}
```

**3. Add `_installLegacyRegExpAccessors(RegExpCtor)` — call once during `buildImports`** (line 4246):

```typescript
function _installLegacyRegExpAccessors(C: any): void {
  const slots: Array<[string, string[], () => string, ((v: any) => void)?]> = [
    ["input",         ["$_"],   () => _legacyRegExpState.input,        (v) => { _legacyRegExpState.input = String(v); }],
    ["lastMatch",     ["$&"],   () => _legacyRegExpState.lastMatch],
    ["lastParen",     ["$+"],   () => _legacyRegExpState.lastParen],
    ["leftContext",   ["$`"],   () => _legacyRegExpState.leftContext],
    ["rightContext",  ["$'"],   () => _legacyRegExpState.rightContext],
  ];
  for (const [name, aliases, getter, setter] of slots) {
    const desc: PropertyDescriptor = {
      get(this: any) {
        if (this !== C) throw new TypeError(`RegExp.${name} getter requires the RegExp constructor as this`);
        return getter();
      },
      enumerable: false,
      configurable: true,
    };
    if (setter) {
      desc.set = function (this: any, v: any) {
        if (this !== C) throw new TypeError(`RegExp.${name} setter requires the RegExp constructor as this`);
        setter(v);
      };
    }
    Object.defineProperty(C, name, desc);
    for (const alias of aliases) Object.defineProperty(C, alias, desc);
  }
  // $1..$9 — read-only
  for (let i = 1; i <= 9; i++) {
    const idx = i - 1;
    Object.defineProperty(C, `$${i}`, {
      get(this: any) {
        if (this !== C) throw new TypeError(`RegExp.$${i} getter requires the RegExp constructor as this`);
        return _legacyRegExpState.parens[idx];
      },
      enumerable: false,
      configurable: true,
    });
  }
}
```

Call site: in `buildImports` (line 4246), after the `env` map is populated, look up the `RegExp` constructor (from `deps?.RegExp ?? builtinCtors.RegExp ?? globalThis.RegExp`) and call `_installLegacyRegExpAccessors(RegExp)`. **Idempotency guard**: only install once per RegExp identity — track via a `WeakSet` so re-instantiating the module doesn't double-register.

**4. Hook the update calls.** Three integration points:

   (a) **`extern_class` `method` handler** (line 1610-1617) — when `m === "exec"` or `m === "test"` and `self` is a RegExp instance and `args[0]` is a string, capture the result before returning:
   ```typescript
   if ((m === "exec" || m === "test") && self instanceof RegExp && typeof args[0] === "string") {
     const input = args[0];
     // For .test(), V8 returns boolean — re-run .exec() for slot data only when match succeeded
     const ret = fn.call(self, ...args);
     if (m === "exec" && ret != null) _updateLegacyRegExpState(input, ret as RegExpExecArray);
     else if (m === "test" && ret === true) {
       // Spec: test() also updates slots. Use a one-shot exec on a clone to avoid
       // perturbing self.lastIndex (sticky/global semantics).
       const clone = new RegExp(self.source, self.flags.replace("g", "").replace("y", ""));
       const m2 = clone.exec(input);
       if (m2) _updateLegacyRegExpState(input, m2);
     }
     return ret;
   }
   ```
   Refactor cleanly — don't duplicate the `fn.call` path.

   (b) **`string_method` handler** (line 1506-1523) — when `method === "match"`, `"search"`, `"replace"`, `"split"`, `"matchAll"` and the first arg is a RegExp, intercept the result similarly. Spec: §22.1.3.x for each — all of them invoke `RegExpBuiltinExec` which updates the slots. Implement once in a `_maybeUpdateLegacyRegExpStateForStringMethod(method, recv, args, ret)` helper.

   (c) **`__extern_method_call` handler** (line 2843-2943) — same hook on `exec`/`test` when receiver is a RegExp.

**5. Wire `RegExp_exec` and similar typed extern imports** — these are dispatched through the `extern_class` `method` handler already, so 4(a) covers them.

#### Edge cases

- **`exec` on non-RegExp receiver via `.call()`** — `RegExp.prototype.exec.call({…fakeRe}, str)`: V8's RegExpExec calls user `exec`. Per spec §22.2.7.1 only built-in `RegExpBuiltinExec` updates the slots, not user `exec`. Implementation: only update when `self instanceof RegExp` (already guarded above).
- **`test()` and sticky/global flags**: the clone strips `g`/`y` to avoid perturbing the user's `lastIndex` while still capturing slot data.
- **Slot persistence across module instances**: `_legacyRegExpState` is module-private, so two instances of `buildImports` have isolated state, matching V8's one-realm-one-state behavior.
- **Cross-realm tests** (`this-cross-realm-constructor.js`, 5 tests): the `SameValue(C, thisValue)` check in our getter catches cross-realm `other.RegExp` correctly because `other.RegExp !== C`. Once `$262.createRealm` returns a separate global with its own `RegExp` (which is a separate runtime concern, see #1334 / Realms goal), our getter throws TypeError as required. **Without** realm support, cross-realm tests cannot run their setup (`$262.createRealm()` returns undefined), so they `compile_error`/`fail` for an unrelated reason — tracked under the realm support track, not here.

#### Spec citations
- §B.2.2.1 `RegExp.input` / `RegExp.$_`
- §B.2.2.2 `RegExp.lastMatch` / `RegExp["$&"]`
- §B.2.2.3 `RegExp.lastParen` / `RegExp["$+"]`
- §B.2.2.4 `RegExp.leftContext` / `RegExp["$\`"]`
- §B.2.2.5 `RegExp.rightContext` / `RegExp["$'"]`
- §B.2.2.6 `RegExp.$1` … `RegExp.$9`
- §B.2.2.1.1 GetLegacyRegExpStaticProperty
- §B.2.2.1.2 SetLegacyRegExpStaticProperty
- §22.2.7.2 RegExpBuiltinExec — step 25-26 invokes the slot update.

#### Acceptance for sub-bucket (d)

- `prop-desc.js` (×5): pass — our `Object.defineProperty` produces descriptors with `enumerable: false`, `configurable: true`, both `get` and `set` (or get-only for read-only slots) per spec.
- `this-not-regexp-constructor.js` (×5): pass — our getter/setter throws TypeError when `this !== C`.
- `this-subclass-constructor.js` (×5): pass — subclass identity ≠ `C`, our getter throws.
- `this-cross-realm-constructor.js` (×5): may still fail because `$262.createRealm()` is unsupported (separate concern); the *accessor logic itself* would be correct if the realm setup succeeded.

Acceptance count target: **12 of 17 fail→pass** (the same-realm tests). Cross-realm 5 tracked under realm support.

### Test files to verify after fix
- `built-ins/RegExp/S15.10.1_A1_T*.js` (sub-cluster a)
- `annexB/built-ins/RegExp/legacy-accessors/*/prop-desc.js` (sub-cluster d.1)
- `annexB/built-ins/RegExp/legacy-accessors/*/this-not-regexp-constructor.js` (sub-cluster d.2)
- `annexB/built-ins/RegExp/legacy-accessors/*/this-subclass-constructor.js` (sub-cluster d.3)
- Skip-filter regression: ensure CI dashboard total drops by 5 (cross-realm tests now skipped).
