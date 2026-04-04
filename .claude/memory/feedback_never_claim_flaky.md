---
name: feedback_never_claim_flaky
description: CRITICAL — never dismiss test262 regressions as flaky. Always bisect and fix.
type: feedback
---

Never claim test262 regressions are "runner instability" or "flaky tests" without proof.

**Why:** A 1,514 pass regression was dismissed as "runner instability" for hours. It was real — caused by #855 and #831. The dismissal delayed the fix and wasted multiple test262 runs.

**How to apply:**
1. Any pass count drop → immediately create a priority issue to bisect
2. Dispatch a dev agent to identify the exact culprit commit(s) using `scripts/diff-test262.ts`
3. Only AFTER bisection confirms the same code produces different results on consecutive runs may it be called "flaky"
4. Fix the regression before any other work continues
5. Never merge on top of a known regression
