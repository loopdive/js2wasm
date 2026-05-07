---
id: 1318
sprint: 50
title: "test harness: 'returned N' bare exit code — capture last assertion detail (~8,900 vague failures)"
status: ready
created: 2026-05-07
updated: 2026-05-07
priority: high
feasibility: medium
reasoning_effort: medium
task_type: improvement
area: test-infrastructure
goal: spec-completeness
---
# #1318 — `returned N` bare exit code (8,900+ vague assertion failures)

## Problem

The single largest failure category is `assertion_fail` with 8,897 entries. The majority of these look like:

```
returned 2 — assert #3 at L15: assert.sameValue(result, expected, "message..."
```

The message is **truncated** — the assertion source code is cut mid-line, making it impossible to know the actual vs expected value. In the worst cases, the error is just:

```
returned 2
```

With zero context at all. This accounts for ~52 bare "returned N" entries and hundreds of truncated-assertion failures.

## Root cause

In `scripts/test262-worker.mjs`, when the test calls `$262.$262Fail(msg)` or throws a `Test262Error`, the worker captures the thrown message and stores it in the result. But:

1. **Truncation**: The message field has a character limit (likely from a `JSON.stringify` truncation or a fixed buffer). Long assertion messages are cut at ~200 chars.
2. **Bare exit codes**: When the Wasm module exits via `proc_exit(2)` (WASI) or returns a non-zero code without throwing, the worker records only `returned N` with no message because the test harness never called `$262.$262Fail`.

## Fix approach

1. **Increase message buffer**: Remove or raise the truncation limit for `error` field in test results. JSONL lines are one per test — a 2KB error message is fine.

2. **Capture `$262.agent.report` queue**: Some tests communicate results via `$262.agent.report(msg)` before failing. Capture all queued reports and append them to the error message.

3. **Capture Wasm return value context**: When a test "returned N" (non-zero exit), include the last `$262.$262Fail` message if any was called before exit. The test harness in `test262-worker.mjs` can track the last failure message in a mutable cell and surface it when the return code is non-zero.

4. **For WASI proc_exit(N)**: Include the exit code meaning (2 = test failure in test262 harness convention).

## Acceptance criteria

- `assert.sameValue(actual, expected, msg)` failures show both the actual and expected values.
- `returned 2` with no context never appears — replaced by the last `$262.$262Fail` message.
- Message field in JSONL is not truncated below 500 chars.
- The truncated-assertion count drops by >80% (most become diagnosable).
