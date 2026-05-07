---
id: 1357
sprint: backlog
title: "spec backlog: AbstractModuleSource constructor (Stage 3 import-source proposal, 8 test262 fails)"
status: backlog
created: 2026-05-08
priority: low
feasibility: medium
reasoning_effort: medium
task_type: feature
area: runtime
language_feature: modules
goal: spec-completeness
parent: 1334
related: 1315
---
# #1357 — AbstractModuleSource: Stage 3 import-source / source-phase imports

## Problem

`built-ins/AbstractModuleSource`: **0 / 8 (0%) — 8 fails (all type_error)**.

Spec §16.2 (Stage 3 source-phase imports proposal) introduces:
1. **`import source X from "mod"`** — imports the module's *source* (a host-defined object
   like `WebAssembly.Module`) instead of the module's namespace.
2. **`%AbstractModuleSource%`** — the abstract intrinsic constructor that user-defined source
   types extend (e.g. `WebAssembly.Module`'s prototype chain ends at `%AbstractModuleSource%.prototype`).
3. The constructor itself throws when called directly (it's abstract).

The 8 failures are all `type_error` — we don't expose `%AbstractModuleSource%` as a value at
all, so the tests fail on first reference.

## Acceptance criteria

1. `built-ins/AbstractModuleSource/abstract-class-no-construct.js` passes.
2. `built-ins/AbstractModuleSource/prototype/Symbol.toStringTag.js` passes.
3. `built-ins/AbstractModuleSource/prototype-of-prototype.js` passes.
4. WebAssembly.Module instances inherit from `%AbstractModuleSource%.prototype` per spec.
5. Pass-rate for `built-ins/AbstractModuleSource` rises from 0% to 100%.

## Implementation notes

The intrinsic itself is small (just a constructor that throws + a prototype with `Symbol.toStringTag`).
The harder bit is hooking the prototype chain of host-provided source types — but in our case the
only "source" type is WebAssembly.Module, which is host-provided in JS-host mode and not yet exposed
to user code in standalone mode.

Sketch:
```javascript
const AbstractModuleSource = function() {
  throw new TypeError("AbstractModuleSource is abstract");
};
Object.defineProperty(AbstractModuleSource.prototype, Symbol.toStringTag, {
  get() {
    if (!isModuleSource(this)) throw new TypeError();
    return Get(this, "[[ModuleSourceClassName]]");
  }
});
// In JS-host mode, splice into WebAssembly.Module's prototype chain at module init.
```

## Files (eventual)

- `src/codegen/registry/intrinsics.ts` — register %AbstractModuleSource%
- `src/runtime.ts` — `__abstract_module_source_*` helpers
- Related: #1315 (import defer source early-error gap)

## Dependency

Stage 3 proposal — may not be Stage 4 yet at audit time. Verify spec status before scheduling.
