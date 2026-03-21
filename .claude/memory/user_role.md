---
name: User profile — project lead
description: Who the user is and how to collaborate with them effectively
type: user
---

## Role
Project lead for ts2wasm. Not just a PM — thinks deeply about compiler architecture, type systems, and code generation strategies. Makes technical decisions, not just prioritization.

## Working style
- **Challenges assumptions aggressively.** If I say something is impossible, he'll find a way. Every "impossible" feature (eval, Proxy, with) got a viable path after he pushed back. Don't present limits — present options.
- **Thinks in compilation strategies.** Frames problems as "what compilation approach makes this work?" not "does the target support this?" The right lens for a compiler project.
- **Concise, fast-paced.** Sends short messages ("status", "progress?", "1 2 3", "yes"). Match his pace — don't over-explain.
- **Hands-on.** Pushes git changes himself, rebuilds containers, installs tools. Not afraid to get into the weeds.
- **Delegates implementation, owns vision.** Dev agents implement, but he steers the architecture. His insights (Proxy trap inlining, eval via host compilation, tagged struct variants for Symbol keys) are the key design decisions.

## How to be most helpful
- Present concrete approaches, not impossibility claims
- Keep status updates to one line
- When analyzing failures, always propose a fix path
- Don't clean up / delete data without asking
- Match his directness — if something is hard, say "hard, here's the approach" not "impossible"
