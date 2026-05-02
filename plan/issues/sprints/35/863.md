---
id: 863
title: "decodeURI/encodeURI failures: #0-0 error pattern (70 FAIL)"
status: done
created: 2026-03-29
updated: 2026-04-14
completed: 2026-04-14
priority: low
feasibility: medium
goal: platform
test262_fail: 70
---
# #863 -- decodeURI/encodeURI failures: #0-0 error pattern (70 FAIL)

## Problem

70 tests fail with the error message `#0-0` (or similar `#N-N` pattern). All are from the `built-ins/decodeURI` and `built-ins/decodeURIComponent` test categories. These tests verify UTF-8 encoding/decoding edge cases in `decodeURI()` and `decodeURIComponent()`.

## Sample files

- `test/built-ins/decodeURI/S15.1.3.1_A1.13_T1.js`
- `test/built-ins/decodeURI/S15.1.3.1_A1.14_T1.js`
- `test/built-ins/decodeURI/S15.1.3.1_A1.15_T1.js`
- `test/built-ins/decodeURIComponent/S15.1.3.2_A1.13_T1.js`

## Root cause

The decodeURI/encodeURI host imports likely have incomplete handling of multi-byte UTF-8 sequences. The `#0-0` error format comes from the test harness's assertion numbering (test assertion #0 at index 0 failed). The URI encoding functions are not properly validating or decoding surrogate pairs and 3/4-byte UTF-8 sequences.

## Acceptance criteria

- 70 decodeURI/encodeURI tests pass
- Correct handling of multi-byte UTF-8 in URI encoding/decoding
