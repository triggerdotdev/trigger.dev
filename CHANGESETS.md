# Changesets

Trigger.dev uses [changesets](https://github.com/changesets/changesets) to manage updated our packages and releasing them to npm.

## Adding a changeset

To add a changeset, use `pnpm run changeset:add` and follow the instructions [here](https://github.com/changesets/changesets/blob/main/docs/adding-a-changeset.md). Please only ever select one of our public packages when adding a changeset, which currently are:

- `@trigger.dev/sdk`
- `@trigger.dev/integration-sdk`
- `@trigger.dev/github`
- `@trigger.dev/notion`
- `@trigger.dev/slack`
- `@trigger.dev/shopify`
- `@trigger.dev/resend`

## Release instructions

Based on the instructions [here](https://github.com/changesets/changesets/blob/main/docs/intro-to-using-changesets.md)

1. Run `pnpm run changeset:version`
2. Run `pnpm run changeset:release`

## Pre-release instructions

1. Add changesets as usual `pnpm run changeset:add`
2. Switch to pre-release mode by running `pnpm run changeset:next`
3. Create version `pnpm run changeset:version`
4. Release `pnpm run changeset:release`
5. Switch back to normal mode by running `pnpm run changeset:normal`
