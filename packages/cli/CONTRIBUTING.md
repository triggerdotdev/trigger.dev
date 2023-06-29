# How to run the CLI locally

First, cd into the cli directory:

```sh
cd packages/cli
```

Then run `pnpm run dev` which will build and re-build on any changes to the CLI package

Next, head to an example repo (e.g. `examples/nextjs-clerk`) and add the package to `devDependencies` if it's not already:

```json
"devDependencies": {
  "@trigger.dev/cli": "workspace:*"
},
```

After running `pnpm i`, you should be able to cd to the `examples/nextjs-clerk` and then run `pnpm exec cli` to run the `@trigger.dev/cli`. You won't need to keep doing `pnpm i` or anything to pickup changes from `packages/cli`.
