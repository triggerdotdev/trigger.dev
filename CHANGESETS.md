# Changesets and Server Changes

Trigger.dev uses [changesets](https://github.com/changesets/changesets) to manage package versions and releasing them to npm. For server-only changes, we use a lightweight `.server-changes/` convention.

## Adding a changeset (package changes)

To add a changeset, use `pnpm run changeset:add` and follow the instructions [here](https://github.com/changesets/changesets/blob/main/docs/adding-a-changeset.md). Please only ever select one of our public packages when adding a changeset.

## Adding a server change (server-only changes)

If your PR only changes server components (`apps/webapp/`, `apps/supervisor/`, etc.) and does NOT change any published packages, add a `.server-changes/` file instead of a changeset:

```sh
cat > .server-changes/fix-batch-queue-stalls.md << 'EOF'
---
area: webapp
type: fix
---

Speed up batch queue processing by removing stalls and fixing retry race
EOF
```

- `area`: `webapp` | `supervisor` | `coordinator` | `kubernetes-provider` | `docker-provider`
- `type`: `feature` | `fix` | `improvement` | `breaking`

For **mixed PRs** (both packages and server): just add a changeset. No `.server-changes/` file needed.

See `.server-changes/README.md` for full documentation.

## When to add which

| PR changes | What to add |
|---|---|
| Only packages (`packages/`) | Changeset (`pnpm run changeset:add`) |
| Only server (`apps/`) | `.server-changes/` file |
| Both packages and server | Just the changeset |

## Release instructions (CI)

Please follow the best-practice of adding changesets in the same commit as the code making the change with `pnpm run changeset:add`, as it will allow our release.yml CI workflow to function properly:

- Anytime new changesets are added in a commit in the `main` branch, the [changesets-pr.yml](./.github/workflows/changesets-pr.yml) workflow will run and will automatically create/update a PR with a fresh run of `pnpm run changeset:version`.
- The release PR body is automatically enhanced with a clean, deduplicated summary that includes both package changes and `.server-changes/` entries.
- Consumed `.server-changes/` files are removed on the `changeset-release/main` branch — the same way changesets deletes `.changeset/*.md` files. When the release PR merges, they're gone from main.
- When the version PR is merged into `main`, the [release.yml](./.github/workflows/release.yml) workflow will automatically build, release packages to npm, and create a single unified GitHub release.

## Pre-release instructions

1. Add changesets as usual `pnpm run changeset:add`
2. Switch to pre-release mode by running `pnpm run changeset:next`
3. Create version `pnpm run changeset:version`
4. Release `pnpm run changeset:release`
5. Switch back to normal mode by running `pnpm run changeset:normal`

## Snapshot instructions

1. Update the `.changeset/config.json` file to set the `"changelog"` field to this:

```json
"changelog": "@changesets/cli/changelog",
```

2. Do a temporary commit (do NOT push this, you should undo it after)

3. Run `./scripts/publish-prerelease.sh prerelease`

You can choose a different tag if you want, but usually `prerelease` is fine.

5. Undo the commit where you updated the config.json file.
