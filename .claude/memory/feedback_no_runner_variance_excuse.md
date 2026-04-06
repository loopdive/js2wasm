---
name: feedback_no_runner_variance_excuse
description: CRITICAL — never claim runner variance. The compiler is idempotent. Different results mean different code or different test conditions.
type: feedback
---

Never claim "runner variance" to explain pass count differences. The compiler is proven idempotent (#923).

**Why:** The tech lead repeatedly dismissed 500-1,400 pass deltas as "runner instability" without investigating. This delayed finding the real #855 regression by hours and led to accepting 17,241 as "close enough" to 17,688 without bisecting the 447-pass gap.

**How to apply:**
1. Any pass count delta > 0 between runs on the same code = real issue, not variance
2. If two runs differ: check what's different (bundle source, test list, cache, worker count, memory)
3. If they should be identical: run `scripts/diff-test262.ts` and categorize every regression
4. Never write "runner variance" or "runner instability" without first proving the same binary produces different results in consecutive runs with no other processes competing
5. If #943 is truly memory-pressure variance, prove it by running twice back-to-back with identical conditions and showing the delta
