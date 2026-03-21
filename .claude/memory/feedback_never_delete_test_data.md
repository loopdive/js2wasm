---
name: Never delete test data without asking
description: Always ask before deleting or clearing test262 cache, results, or any test data files
type: feedback
---

Never delete test262 cache files, result files, or any test data without explicitly asking the user first.

**Why:** Test data is valuable and hard to reproduce. The user was upset when I attempted to clear the test262 results cache without asking.

**How to apply:** Before any operation that would delete, clear, or overwrite files in `benchmarks/results/`, always ask the user for permission first. This includes cache files like `test262-results.jsonl` and report files.
