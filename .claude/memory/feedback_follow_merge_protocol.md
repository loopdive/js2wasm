---
name: feedback_follow_merge_protocol
description: CRITICAL — follow the documented merge protocol exactly, don't shortcut by merging as tech lead
type: feedback
originSessionId: 0ffbd21c-b73d-429a-a76d-4fb742ea9794
---
**Merge protocol is now PR + CI, not local tester agents.** The old tester-agent protocol (spawning a short-lived tester to run test262 locally) is retired. Test262 runs in GitHub Actions on every PR.

Current protocol (see CLAUDE.md "Merge protocol"):
1. Dev merges `origin/main` into branch BEFORE opening PR
2. Dev pushes branch, opens PR against `main`
3. GitHub Actions sharded test262 runs on the PR branch, writes `.claude/ci-status/pr-<N>.json`
4. Dev waits (idle) for CI result on matching SHA
5. Dev self-merges via `gh pr merge <N> --admin --merge` when `net_per_test > 0`
6. Tech lead escalation only for: regressions >10, bucket >50, judgment call

**Why retained:** The underlying lesson (never skip test262 verification) still holds. The mechanism changed — CI does it now, not a local tester. The rule "don't merge without test262 confirmation" is still the invariant.

**How to apply:**
- Never admin-merge a PR without a `.claude/ci-status/pr-<N>.json` result on a matching SHA
- The ci-status feed is the test262 confirmation — it replaces the old merge-proof.json
- Only exception: docs-only changes with zero `src/` changes
