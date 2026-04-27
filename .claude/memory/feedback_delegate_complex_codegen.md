---
name: delegate complex codegen investigation to senior-dev
description: Complex regression investigations in IR/codegen or CI drift should be delegated to a senior-dev (Opus) agent, not handled by the tech lead (Sonnet) directly
type: feedback
originSessionId: 0ffbd21c-b73d-429a-a76d-4fb742ea9794
---
When a regression appears in IR, codegen, or test-runner drift, delegate the investigation and fix to a senior developer running Opus, not the tech lead (Sonnet). The tech lead should identify that a regression exists and spawn a senior-dev to root-cause it.

**Why:** The tech lead is a Sonnet model. Deep compiler analysis (IR gate logic, call-graph closure correctness, from-ast.ts throw paths) and test-runner bug analysis is Opus-level work. In the #1160 drift investigation, the tech lead incorrectly diagnosed null Symbol.iterator as the cause of `%Array%.from` errors and opened PR #34 with a wrong fix, causing 559 regressions (-303 net pass). The existing `tests/issue-1160.test.ts` already documented that null is harmless for `Array.from`. A wrong causal chain from a session summary led to the bad fix.

**How to apply:** When CI shows unexpected compile_errors, regressions, or a persistent drift pattern (same error cluster across multiple unrelated PRs), spawn a `senior-developer` agent (Opus) with: the observed pattern, what has already been ruled out, the relevant files, and any wrong-fix PRs to close. The tech lead does not implement the fix itself.
