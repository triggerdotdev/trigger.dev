# Changesets

Trigger.dev uses [changesets](https://github.com/changesets/changesets) to manage updated our packages and releasing them to npm.

## Adding a changeset

To add a changeset, use `pnpm run changeset:add` and follow the instructions [here](https://github.com/changesets/changesets/blob/main/docs/adding-a-changeset.md). Please only ever select one of our public packages when adding a changeset.

## Release instructions (local only)

Based on the instructions [here](https://github.com/changesets/changesets/blob/main/docs/intro-to-using-changesets.md)

1. Run `pnpm run changeset:version`
2. Run `pnpm run changeset:release`

## Release instructions (CI)

Please follow the best-practice of adding changesets in the same commit as the code making the change with `pnpm run changeset:add`, as it will allow our release.yml CI workflow to function properly:

- Anytime new changesets are added in a commit in the `main` branch, the [release.yml](./.github/workflows/release.yml) workflow will run and will automatically create/update a PR with a fresh run of `pnpm run changeset:version`.
- When the version PR is merged into `main`, the release.yml workflow will automatically run `pnpm run changeset:release` to build and release packages to npm.

## Pre-release instructions

1. Add changesets as usual `pnpm run changeset:add`
2. Switch to pre-release mode by running `pnpm run changeset:next`
3. Create version `pnpm run changeset:version`
4. Release `pnpm run changeset:release`
5. Switch back to normal mode by running `pnpm run changeset:normal`

## Snapshot instructions

1. Delete the `.changeset/pre.json` file (if it exists)

2. Do a temporary commit (do NOT push this, you should undo it after)

3. Copy the `GITHUB_TOKEN` line from the .env file

4. Run `GITHUB_TOKEN=github_pat_12345 ./scripts/publish-prerelease.sh re2`

Make sure to replace the token with yours. `re2` is the tag that will be used for the pre-release.

5. Undo the commit where you deleted the pre.json file.
