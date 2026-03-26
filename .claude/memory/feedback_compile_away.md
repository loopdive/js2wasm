---
name: Compile away, don't emulate
description: General strategy — resolve JS semantics at compile time via static analysis, not runtime data structures. Zero overhead.
type: feedback
---

**Compile away, don't emulate.** When implementing JS runtime semantics (property descriptors, freeze/seal, typeof, instanceof, etc.), prefer static analysis over runtime data structures.

Wrong approach: add runtime metadata (flags arrays, hidden fields, tag bytes) to every object and check them at every access. This adds overhead to ALL code, even code that never uses the feature.

Right approach: the compiler already knows the types. Track semantic state (frozen, non-writable, sealed) in the **compiler's type system** and emit the correct code at compile time.

Examples:
- `Object.freeze(obj)` → compiler marks type as frozen, subsequent writes emit TypeError throw. No runtime flag.
- `Object.defineProperty(obj, 'x', {writable: false})` → compiler marks field non-writable, writes emit TypeError. No per-property flags.
- `Object.getOwnPropertyDescriptor(obj, 'x')` → compiler knows attributes statically, inlines constant descriptor.
- `typeof x` → compiler knows the type, emits string constant.

Fallback for dynamic cases (externref, unknown types): delegate to host imports. But the static path should be the default.

**Why:** This is what makes a compiler better than an interpreter. An interpreter must carry metadata at runtime. A compiler resolves it at compile time. Zero overhead for the common case.

**How to apply:** Before adding ANY runtime field or check to support a JS feature, ask: "Can the compiler resolve this statically?" If yes, do that. Only add runtime support for genuinely dynamic cases.
