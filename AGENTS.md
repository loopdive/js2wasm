# Agent Instructions

## Claude Memories

- Before substantial work, review the markdown memories under [.claude/memory](/Users/thomas/Documents/Arbeit/Startup/Projekte/Mosaic/code/@loopdive/ts2wasm/.claude/memory).
- Start with [MEMORY.md](/Users/thomas/Documents/Arbeit/Startup/Projekte/Mosaic/code/@loopdive/ts2wasm/.claude/memory/MEMORY.md), then read any task-relevant files in the same directory.
- Treat those memory files as repo-specific operating context, especially around test262 workflow, agent coordination, cleanup rules, and user preferences.

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
