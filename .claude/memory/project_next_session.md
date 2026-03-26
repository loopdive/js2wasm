---
name: project_next_session
description: 2026-03-26 session state — 16,971 pass (+1,817), subsystem work queued
type: project
---

## Current state (2026-03-26 end of session)

**Git:** main branch, ~30 commits this session
**Latest test262:** 16,971 pass / 32,871 fail (49,842 total)
**Honest baseline start:** 15,154 pass
**Session gain:** +1,817

## Key fixes landed
- Exception tag export (#792) — fixed error classification
- struct.new type mismatches (728 CE → 0)
- catch_all for foreign JS exceptions (#798a)
- SyntaxError early detection (#791, 7 checks)
- TDZ in closures + for-loop let/const (#790)
- Null TypeError guards (#775, #789)
- Arguments externref vec (#771)
- Illegal cast guards (ref.test before ref.cast)
- Call type hints at 7 call sites (#511)
- hasOwnProperty accessor fix
- Destructuring defaults (#796)
- f64 unbox for boxed capture compound assignments (#795)
- Skip filters: private class element hangs, strict-mode-only tests

## Subsystem plans (queued for future sessions)
- **#797** Property descriptors — compile-away approach (static analysis, zero runtime overhead)
  - #797a: per-shape descriptor table (compile-time)
  - #797b-d: getOwnPropertyDescriptor, defineProperty, freeze/seal
- **#798** try/catch interop — #798a landed (catch_all), #798b-c remaining
- **#799** Prototype chain — $__proto__ linked list
- **#800** Audit: replace runtime emulation with compile-time resolution

## Key principle established
**Compile away, don't emulate.** Resolve JS semantics at compile time via static analysis. No runtime data structures for features that can be determined statically (TDZ, property descriptors, typeof, freeze).

## Test infra improvements
- Auto-rebuild bundle in test262 script
- 10s per-test timeout
- 2 workers during dev, 3 workers for solo measurement
- Devs compile+run specific tests, never run full suite
- bypassPermissions default in settings.json

## Team rules (updated)
- Up to 8 devs when not running test262
- TTL runs all tests (no tester teammate)
- PO on demand only
- Devs validate by compiling AND running specific test files
