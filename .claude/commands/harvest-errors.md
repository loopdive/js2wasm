# Harvest Test262 Errors

Analyze the latest test262 run results, cross-reference with existing issues, and create new issues for unaddressed error patterns.

## Steps

1. Find the latest test262 results JSONL file:
   - Check `benchmarks/results/test262-results.jsonl`
   - If empty, find the largest file in `benchmarks/results/runs/`

2. Parse all results and categorize errors:
   - **Compile errors**: group by pattern (undefined .kind, stack underflow, local.set mismatch, struct error, call mismatch, missing import, stack fallthrough, unsupported, missing property, yield outside gen, await outside async, etc.)
   - **Runtime failures**: group by pattern (returned wrong with assert info, null pointer deref, timeout, illegal cast, array OOB, unreachable, uncaught exception)
   - For each pattern, count occurrences and collect 3 sample file paths

3. Cross-reference with existing issues:
   - Read issue files in `plan/issues/`
   - Match error patterns to existing issue titles/descriptions
   - Mark each pattern as: ADDRESSED (`status: done`), IN PROGRESS (`status: ready` / `in-progress` / `review`), or NEW

4. For NEW patterns with >50 occurrences:
   - Create issue files in `plan/issues/` with next available number
   - Include: priority (based on count), sample files, root cause analysis, suggested fix
   - Update `plan/issues/backlog/backlog.md`

5. For ADDRESSED patterns where count INCREASED vs the issue's original count:
   - Flag as potential regression
   - Add a note to the issue file

6. Output a summary table:
   ```
   Pattern | Count | Status | Issue #
   --------|-------|--------|--------
   null deref | 2,560 | #663 done | regression?
   assert.throws | 4,738 | #695 open | tracked
   ...
   ```

7. Commit all new/updated issue files with a descriptive message.

Always check `free -h` before running to ensure enough memory. Never delete test data.
