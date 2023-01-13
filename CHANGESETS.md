# Changesets

Trigger.dev uses [changesets](https://github.com/changesets/changesets) to manage updated our packages and releasing them to npm.

## Release instructions

Based on the instructions [here](https://github.com/changesets/changesets/blob/main/docs/intro-to-using-changesets.md)

1. Run `pnpm run changeset:version`
2. Run `pnpm run changeset:release`

## Adding a changeset

To add a changeset, use `pnpm run changeset:add` and follow the instructions [here](https://github.com/changesets/changesets/blob/main/docs/adding-a-changeset.md). Please only ever select one of our public packages when adding a changeset, which currently are:

- `@trigger.dev/sdk`
- `@trigger.dev/integrations`
