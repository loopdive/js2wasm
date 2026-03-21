---
name: test262 error analysis procedure
description: Step-by-step procedure for analyzing test262 results and creating/updating issues
type: reference
---

## Test262 Error Analysis Procedure

### 1. Run test262 suite
```bash
npx tsx scripts/run-test262.ts
```
Output: `benchmarks/results/test262-results.jsonl` (one JSON line per test)

### 2. Generate summary report
```bash
python3 -c "..." # Parse JSONL, count by status, write benchmarks/results/test262-report.json
```
Key fields: status = pass | fail | compile_error | skip

### 3. Analyze error patterns
Group by:
- **Compile errors**: Extract first error message, normalize (strip line/col), count by pattern
- **Failures**: Group by error message (returned 0, fn not a function, null pointer, SyntaxError expected, etc.)
- **Skips**: Group by reason field

### 4. Deep-dive large buckets
For any pattern >50 tests, classify by reading actual test file content:
- What JS feature is the test exercising? (destructuring, class, generators, etc.)
- What code pattern triggers the error? (call in destructuring, private field access, etc.)
- Use `defaultdict` + file content sampling to get percentage breakdowns

### 5. Cross-reference with existing issues
- Read all issues in plan/issues/ready/ and plan/issues/blocked/
- Match error patterns to existing issue titles/content
- Identify: needs metric update, needs new issue, or already covered

### 6. Split mega-issues
Any issue covering >100 tests with multiple root causes should be split:
- Create focused child issues per root cause
- Update parent to reference children
- Each child gets its own test262_fail/test262_ce count

### 7. Update/create issues
- Update frontmatter: test262_skip, test262_fail, test262_ce
- Create new issues for unmatched patterns with proper metrics
- Move completed issues to done/

### 8. Regenerate graph
```bash
npx tsx plan/generate-graph.ts
```

**Why:** This procedure ensures issues are actionable and properly sized. Large buckets like "629 wrong return values" are useless as issues — the root cause analysis (51% destructuring, 15% private fields, etc.) makes them implementable.

**How to apply:** Run this after every major dev sprint or when test262 results change significantly.
