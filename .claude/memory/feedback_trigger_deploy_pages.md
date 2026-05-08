---
name: trigger deploy-pages after baseline refresh
description: After any test262 baseline refresh (skip-ci commits), manually trigger deploy-pages so the GitHub Pages site reflects the new pass rate
type: feedback
originSessionId: 0ffbd21c-b73d-429a-a76d-4fb742ea9794
---
After committing a test262 baseline refresh (`[skip ci]`), always manually trigger the pages deploy:

```bash
gh workflow run deploy-pages.yml --ref main
```

**Why:** `[skip ci]` baseline refresh commits don't trigger CI/deploy workflows (intentional, prevents loops). But this means the GitHub Pages site stays stale until the next real PR merge. Manually triggering closes that gap immediately.

**How to apply:** Any time `test262-current.json` is updated via a `[skip ci]` commit (whether via refresh-committed-baseline.yml or manual), follow up with the workflow dispatch above.
