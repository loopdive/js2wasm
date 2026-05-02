---
id: 867
title: "Playground: interactive test262 conformance explorer with inline errors"
status: ready
created: 2026-03-29
updated: 2026-04-28
priority: high
feasibility: medium
reasoning_effort: high
goal: developer-experience
depends_on: [861]
required_by: [868]
---
# #867 -- Playground: interactive test262 conformance explorer

## Overview

Integrate test262 conformance data into the playground's "Unit tests / ECMAScript Test Suite" section. Replace the current static view with an interactive, drill-down explorer showing pass/fail/CE/timeout/skip per category, subcategory, and individual test file.

## Requirements

### 1. Summary stats at top of section

Show the headline numbers prominently:
```
18,167 pass | 21,663 fail | 1,966 CE | 289 timeout | 6,580 skip | 47,797 total (38.0%)
```

With a colored progress bar (green=pass, red=fail, yellow=CE, orange=timeout, gray=skip).

### 2. Category tree with colored progress bars

Hierarchical tree: category → subcategory → test file

Each level shows:
- Colored stacked progress bar (pass/fail/CE/timeout/skip proportions)
- Pass percentage number to the right
- Click to expand/collapse

Example:
```
▼ language/expressions          4,596/11,036  41.6%  [██████░░░░░░░░░]
  ▼ class                       1,200/3,500   34.3%  [████░░░░░░░░░░░]
    ▼ elements                    400/1,200   33.3%  [████░░░░░░░░░░░]
      ✓ after-same-line-gen-computed-names.js         pass  12ms
      ✗ after-same-line-gen-computed-symbol-names.js  fail  "returned 2"
      ⊘ after-same-line-gen-rs-private-method.js      CE    "ref.cast..."
```

Color coding:
- Green: pass
- Red: fail
- Yellow: compile_error
- Orange: compile_timeout
- Gray: skip

### 3. Click test file → open in Monaco with inline errors

Clicking a test file:
1. Opens the test262 source in the Monaco editor
2. If the test has a compile error or runtime error:
   - Highlight the error line(s) with a red background
   - Show the error message as an inline decoration below the line (like TypeScript errors in VS Code)
   - If the error includes `[at L15: ...]`, highlight line 15
3. If the test passed, show a green check inline
4. Show compile_ms and exec_ms as subtle inline annotations

### 4. Data source

Read from `benchmarks/results/test262-results.jsonl` and `benchmarks/results/test262-compile.jsonl`. These contain per-test results with:
- `file`, `category`, `status`, `error`, `error_category`
- `compile_ms`, `exec_ms`

For the test source, read from `test262/test/` directory. The playground already has file access patterns.

### 5. Filtering and search

- Search box: filter by test name, error message, or category
- Status filter buttons: pass | fail | CE | timeout | skip (toggleable)
- Sort by: name, status, compile time, exec time

## Technical approach

- Load JSONL data via fetch at startup (or bundle a summary JSON)
- Build category tree from file paths (split on `/`)
- Use Monaco's `deltaDecorations` API for inline error highlighting
- Progress bars: CSS flexbox with proportional widths per status

## Acceptance criteria

- Summary stats visible at top of test suite section
- Category tree with colored progress bars at all levels
- Click to drill down from category → subcategory → file
- Click file opens in Monaco with inline error decorations
- Search/filter works across all levels
- Responsive and fast (48K entries should render progressively)
