# Public Repository Export

This private repository is the source of truth. The public `js2wasm` repository
should be populated from a reduced allowlisted tree.

## Scope

The export keeps:

- compiler source under `src/`
- tests under `tests/`
- playground and public site assets
- the minimal scripts and GitHub workflows needed to build, test, and publish
- top-level project metadata and documentation

The export intentionally excludes:

- `.claude/`
- `.devcontainer/`
- `.playwright/`
- `.vscode/`
- `blog/`
- `dashboard/`
- `plan/`
- benchmark archives, retro data, and other internal operational artifacts
- internal harness or agent-related materials

## Generate A Public Tree

From the private repository root:

```bash
node scripts/export-public-tree.mjs
```

This writes a clean staging tree to:

```text
.tmp/public-export
```

You can also choose a custom destination:

```bash
node scripts/export-public-tree.mjs --out /tmp/js2wasm-public
```

## Publish Flow

The normal one-command flow is now:

```bash
pnpm run publish:public
```

That:

- regenerates the staged export under `.tmp/public-export`
- syncs it into the local public checkout at `../js2wasm-public`
- stops before commit/push so the public diff can still be reviewed

To commit and push in one go:

```bash
pnpm run publish:public -- --commit --push
```

You can also override the target checkout:

```bash
pnpm run publish:public -- --repo-dir /path/to/js2wasm-public --commit
```

The lower-level steps still exist when you want to inspect them independently.

## Sync Into The Public Repository

Once the public repository exists locally, you can still sync the staged export into it directly:

```bash
node scripts/sync-public-repo.mjs --repo-dir ../js2wasm-public
```

This script:

- verifies the target is a Git repository
- verifies `origin` points to the public `loopdive/js2wasm` repo, not `js2wasm-private`
- refuses to run on a dirty target repo unless `--allow-dirty` is passed
- replaces the target working tree with the exported public snapshot while preserving `.git`

After that, either commit manually:

```bash
cd ../js2wasm-public
git status --short
git add .
git commit -m "chore(public): initial public snapshot"
git push origin main
```

Or use the new wrapper:

```bash
pnpm run publish:public -- --commit --push
```

## Notes

- The allowlist is defined in `public-export/allowlist.txt`.
- The final pruning step is defined in `public-export/denylist.txt`.
- Public benchmark inputs for the website now live under `public/benchmarks/results/`.
- The goal is a one-way export: internal planning, dashboards, agent tooling, and
  historical operational data stay private.
