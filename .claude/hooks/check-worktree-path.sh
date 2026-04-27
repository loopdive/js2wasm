#!/bin/bash
# PreToolUse hook: enforce worktree path convention.
#
# Worktrees MUST live under /workspace/.claude/worktrees/<branch-name>/ so
# they're visible to the tech-lead statusline and gitignored. Reject any
# `git worktree add <path>` whose target is outside that root.
#
# Allowed path roots:
#   - /workspace/.claude/worktrees/    ← canonical location
#   - /workspace/test262               ← legacy test262 sharded worktree
#
# Anything else (notably /tmp/worktrees/) is rejected with a hint.
#
# This hook only fires on `git worktree add` — `git worktree remove` /
# `list` / `move` / `prune` / `repair` are unaffected. The block is
# advisory: agents can still bypass it by cd'ing into a directory that
# the previous `cd` would resolve to, but the message + log entry give
# the user a chance to course-correct.

INPUT=$(cat)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)
if [ -z "$CMD" ]; then
  exit 0
fi

# Only intercept `git worktree add`. Other worktree subcommands and any
# non-git command pass through.
if ! echo "$CMD" | grep -qE '(^|[;&|])[[:space:]]*git[[:space:]]+worktree[[:space:]]+add'; then
  exit 0
fi

# Extract the first non-flag argument after `worktree add` — that's the
# target path. Flags consumed: `-b <name>`, `-B <name>`, `--detach`,
# `--force`, `-f`, `--no-checkout`, `--lock`, `--reason <r>`, etc.
#
# We do a lightweight parse: find `worktree add`, walk the rest of the
# tokens, skip flags + their args, take the first non-flag word.
# This isn't bulletproof against pathological flag combos but covers
# every form a human would actually type.
PATH_ARG=$(echo "$CMD" | awk '
  {
    # Find "worktree add" and start scanning after it
    for (i = 1; i <= NF; i++) {
      if ($i == "worktree" && $(i+1) == "add") {
        i = i + 1
        # Skip flags + their args until we find a path token
        while (++i <= NF) {
          tok = $i
          if (tok ~ /^-b$/ || tok ~ /^-B$/ || tok ~ /^--reason$/ ||
              tok ~ /^--checkout-from$/ || tok ~ /^--track$/) {
            i++  # skip the flag arg
            continue
          }
          if (tok ~ /^-/) {
            continue  # boolean flag, no arg
          }
          # First non-flag token is the path
          # Strip surrounding quotes if any
          gsub(/^["'\'']|["'\'']$/, "", tok)
          print tok
          exit
        }
      }
    }
  }
')

if [ -z "$PATH_ARG" ]; then
  # Couldn't extract a path arg — let it through; git itself will
  # complain if the syntax is broken.
  exit 0
fi

# Resolve to absolute path. If PATH_ARG is relative, anchor it to the
# command's working dir (best-effort: use $PWD).
case "$PATH_ARG" in
  /*) ABS_PATH="$PATH_ARG" ;;
  *) ABS_PATH="$PWD/$PATH_ARG" ;;
esac

# Allow these path prefixes:
ALLOWED_PREFIXES=(
  "/workspace/.claude/worktrees/"
  "/workspace/test262"
)

OK=false
for prefix in "${ALLOWED_PREFIXES[@]}"; do
  case "$ABS_PATH" in
    "$prefix"*) OK=true; break ;;
  esac
done

if [ "$OK" = true ]; then
  exit 0
fi

# Log the rejection and emit a helpful message
if [ -f /workspace/.claude/hooks/event-log.sh ]; then
  source /workspace/.claude/hooks/event-log.sh
  log_event "worktree_path_blocked" "path=$ABS_PATH"
fi

cat >&2 <<EOF
BLOCKED: git worktree add target "$ABS_PATH" is outside the canonical worktree root.

Convention: worktrees MUST live under /workspace/.claude/worktrees/<branch-name>/
so they're visible in the tech-lead statusline and covered by .gitignore.

Suggested fix:
  git worktree add /workspace/.claude/worktrees/$(basename "$ABS_PATH") <branch-args...>

(See CLAUDE.md / team-lead memo on worktree convention.)
EOF
exit 2
