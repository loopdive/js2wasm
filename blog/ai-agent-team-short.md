# Beyond Vibe Coding: Agentic Engineering With Structure

Vibe coding is fun for prototypes. AI agents have built C compilers before — but compiling a well-defined language with a formal grammar is a solved problem shape. We're doing something different: compiling full JavaScript semantics to WebAssembly AOT, with no runtime bundled, no language subsetting, and full ECMAScript compatibility as the target. That's uncharted territory — there is no existing compiler that does this.

48,000 conformance tests, 768 closed issues, real engineering. We use a team of Claude agents not as copilots, but as a structured engineering team with roles:

- **Tech Lead** dispatches work, merges branches, runs the test suite
- **Developers** (up to 3 concurrent) implement fixes in isolated git worktrees
- **Product Owner** analyzes test failures, creates issues, prioritizes the backlog
- **Scrum Master** runs retrospectives and improves the process

Each developer agent gets an issue file with the bug description, affected test count, and sample failing tests. They work on an isolated branch, can't touch main, and coordinate through file locks and message passing.

**How we measure:** We run the 48,000-test ECMAScript conformance suite (test262) after every merge. Pass count goes up or it doesn't. No vibes, just numbers.

**How we prioritize:** Every issue has a test count. "#852 — 1,525 failures" beats "#853 — 58 failures." Goals form a dependency graph so we don't chase shiny features while fundamentals are broken.

**How we merge:** Developers rebase onto main before signaling completion. Tech lead merges with fast-forward only. One merge at a time. Serial, boring, nothing breaks.

**How we remember:** Critical rules live in checklist files that agents re-read at the moment of action — not in their initial instructions, which fade as context windows fill up.

The result: 550 passing tests → 18,167 passing tests. 768 issues closed. The agents aren't just writing code — they're running a project.

---

_Built with [Claude Code](https://claude.ai/code). The compiler is [js2wasm](https://github.com/loopdive/js2wasm)._
