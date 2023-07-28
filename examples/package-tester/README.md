This example is used to test the package building and bundling. It intentionally doesn't have any `paths` in the `tsconfig.json` file, so the packages need to be built to use it.

## Initial setup

Create an `.env.local` file, by copying the `.env.local.example` file:

```bash
cd examples/package-tester
cp .env.local.example .env.local
```

Then fill in your API keys from the running local Trigger.dev webapp service.

## Running

Run the development server:

```bash
pnpm run dev --filter @examples/package-tester
```
