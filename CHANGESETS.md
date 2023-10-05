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

!MAKE SURE TO UPDATE THE TAG IN THE INSTRUCTIONS BELOW!

1. Add changesets as usual `pnpm run changeset:add`
2. Create a snapshot version (replace "dev" with your tag) `pnpm exec changeset version --snapshot dev`
3. Build the packages: `pnpm run build --filter "@trigger.dev/*"`
4. Publish the snapshot (replace "dev" with your tag) `pnpm exec changeset publish --no-git-tag --snapshot --tag dev`
