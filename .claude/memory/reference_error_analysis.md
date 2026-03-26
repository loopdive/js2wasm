---
name: test262 error analysis procedure
description: Step-by-step procedure for analyzing test262 results and creating/updating issues
type: reference
---

## Test262 Error Analysis Procedure

### 1. Run test262 suite
```bash
pnpm run test:262
```
Uses vitest-based runner with auto-worktree, disk cache, default 3 workers.
Output: results JSONL + report JSON in `benchmarks/results/runs/`

### 2. Analyze error patterns
Group by:
- **Compile errors**: Extract first error message, normalize (strip line/col), count by pattern
- **Failures**: Group by error message (returned 0, WebAssembly.Exception, null pointer, etc.)
- **Skips**: Group by reason field

Use `node -e` with the results JSONL for quick counts. Do NOT write ad-hoc Python scripts.

### 3. Deep-dive large buckets
For any pattern >50 tests, classify by reading actual test file content:
- What JS feature is the test exercising?
- What code pattern triggers the error?

### 4. Cross-reference with existing issues
- Read all issues in plan/issues/ready/ and plan/issues/blocked/
- Match error patterns to existing issue titles/content
- Identify: needs metric update, needs new issue, or already covered

### 5. Split mega-issues
Any issue covering >100 tests with multiple root causes should be split:
- Create focused child issues per root cause
- Each child gets its own test262_fail/test262_ce count

### 6. Update/create issues
- Update frontmatter: test262_skip, test262_fail, test262_ce
- Create new issues for unmatched patterns with proper metrics
- Move completed issues to done/

**Why:** This procedure ensures issues are actionable and properly sized.

**How to apply:** Run this after every major dev sprint or when test262 results change significantly.
