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

1. Update the private repository normally.
2. Regenerate public-facing artifacts, especially `public/benchmarks/results/*`.
3. Run `node scripts/export-public-tree.mjs`.
4. Review the staged tree under `.tmp/public-export`.
5. Sync that tree into the public `js2wasm` repository.

## Sync Into The Public Repository

Once the public repository exists locally, sync the staged export into it:

```bash
node scripts/sync-public-repo.mjs --repo-dir ../js2wasm-public
```

This script:

- verifies the target is a Git repository
- verifies `origin` points to the public `loopdive/js2wasm` repo, not `js2wasm-private`
- refuses to run on a dirty target repo unless `--allow-dirty` is passed
- replaces the target working tree with the exported public snapshot while preserving `.git`

After that:

```bash
cd ../js2wasm-public
git status --short
git add .
git commit -m "chore(public): initial public snapshot"
git push origin main
```

## Notes

- The allowlist is defined in `public-export/allowlist.txt`.
- The final pruning step is defined in `public-export/denylist.txt`.
- Public benchmark inputs for the website now live under `public/benchmarks/results/`.
- The goal is a one-way export: internal planning, dashboards, agent tooling, and
  historical operational data stay private.
