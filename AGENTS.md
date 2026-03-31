# Agent Instructions

## Commit Messages

- Use Claude Code-style commit messages.
- Write a specific subject line that states the main change clearly.
- Add a body when the change is non-trivial.
- In the body, explain what changed and why it changed.
- Call out behavior changes, important tradeoffs, or follow-up work when relevant.

Preferred shape:

```text
<type>(<scope>): <concise summary>

Explain the main implementation change and the reason for it.

Note behavior changes, risks, or follow-ups if they matter.
```

Examples of acceptable types: `fix`, `feat`, `refactor`, `docs`, `test`, `chore`.
