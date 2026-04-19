---
name: Always fetch the ECMAScript spec before fixing test failures
description: When fixing a test262 failure, identify the spec section, fetch the exact algorithm from tc39.es/ecma262, and implement strictly from the fetched text — never rely on memory for spec details.
type: feedback
originSessionId: 0ffbd21c-b73d-429a-a76d-4fb742ea9794
---
When fixing a test failure:
1. Identify the relevant spec section from the error message and test file name
2. Fetch the exact algorithm from https://tc39.es/ecma262/ (use WebFetch or WebSearch to get the current spec text)
3. Implement strictly according to the fetched spec text
4. Do not rely on memory for spec details — the spec is the source of truth, not recalled knowledge

**Why:** Spec details are subtle (step ordering, edge cases, error types, coercion rules). Relying on memory leads to "close but wrong" implementations that pass obvious cases but fail spec edge cases — exactly the kind of wrong_output bugs that dominate the 11,545-test failure bucket. Fetching the actual spec text before coding catches these upfront.

**How to apply:** Every dev fixing a test262 failure should include the spec section reference (e.g. "§7.1.1 ToPrimitive, step 5") in their commit message and PR body. If they can't cite the spec section, they haven't verified their fix against the spec. This rule applies to all agents — tech lead should verify spec references in PR reviews.
