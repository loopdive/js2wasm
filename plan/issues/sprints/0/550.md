---
id: 550
title: "Security: XSS via error messages in report.html"
status: done
created: 2026-03-18
updated: 2026-04-14
completed: 2026-04-14
priority: medium
goal: test-infrastructure
---
# Issue #550: Security — XSS via error messages in report.html

## Problem
Error messages from test262 results are rendered in `benchmarks/report.html` without explicit HTML entity escaping. While the current DOM API approach (using `createTextNode` and `setAttribute`) is inherently safe, there is no defense-in-depth escaping. A future refactoring could introduce XSS if the rendering approach changes.

## Solution
Add an `escapeHtml` utility function and apply it to all user-controlled strings (error messages, file names, category names) before rendering, providing defense-in-depth.

## Key Files
- `benchmarks/report.html`
