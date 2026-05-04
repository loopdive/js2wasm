---
id: 1295
sprint: 48
title: "compiler.ts: re-throw WebAssembly.Exception from internal catch blocks"
status: done
created: 2026-05-03
updated: 2026-05-03
priority: high
feasibility: easy
reasoning_effort: low
task_type: bugfix
area: test-infrastructure
language_feature: test262-runner
goal: conformance
depends_on: [1294]
related: [1221, 1160]
---
# #1295 — compiler.ts: re-throw WebAssembly.Exception from internal catch blocks

## Background

#1294 fixed the worker's outer `catch` around `doCompile` to send `fail` +
restart fork when a `WebAssembly.Exception` escapes. That fixed ~408 cases.

However ~568 `compile_error: [object WebAssembly.Exception]` remain. These
come from **inside** `src/compiler.ts`, in the codegen and binary-emit catch
blocks that do:

```typescript
} catch (e) {
  pushSourceAnchoredDiagnostic(
    errors, ...,
    `Codegen error: ${e instanceof Error ? e.message : String(e)}`,  // ← String(e) = "[object WebAssembly.Exception]"
    "error",
  );
  return { binary: new Uint8Array(0), ..., success: false, errors };
}
```

`WebAssembly.Exception` is not `instanceof Error`, so `String(e)` yields
`"[object WebAssembly.Exception]"`. The compiler returns a result with a
diagnostic — `doCompile` returns normally — and the worker sends
`status: "compile_error"` with the bad message. The fork-restart logic
(added in #1294) never fires.

## Fix

Add a re-throw guard at the top of each affected catch block:

```typescript
} catch (e) {
  if (typeof WebAssembly !== "undefined" && e instanceof WebAssembly.Exception) throw e;
  pushSourceAnchoredDiagnostic(
    errors, ...,
    `Codegen error: ${e instanceof Error ? e.message : String(e)}`,
    "error",
  );
  ...
}
```

The re-throw propagates out of `compileSource` → out of `doCompile` → caught
by the worker's outer catch (line 857, fixed by #1294) → sends `fail` +
`process.exit(1)` → fork restarts clean.

## Affected lines in src/compiler.ts

| Line | Label |
|------|-------|
| ~376 | single-file codegen catch |
| ~435 | single-file binary-emit catch |
| ~649 | multi-file codegen catch |
| ~700 | multi-file binary-emit catch |

All four need the same one-line guard.

## Acceptance criteria

1. All 4 catch blocks have the re-throw guard
2. `compile_error` category no longer contains `"[object WebAssembly.Exception]"` entries
3. No regression in existing passing tests

## Files

- `src/compiler.ts` — 4 catch blocks (~lines 376, 435, 649, 700)
- `tests/issue-1295.test.ts` — minimal test if feasible

## Expected impact

~568 fewer `compile_error` rows, reclassified as `fail` (or `pass` for
tests with clean fork state).
