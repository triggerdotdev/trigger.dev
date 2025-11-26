## Repo Overview

This is a pnpm 10.16.0 monorepo that uses turborepo @turbo.json. The following workspaces are relevant

## Apps

- <root>/apps/webapp is a remix app that is the main API and dashboard for trigger.dev
- <root>/apps/supervisor is a node.js app that handles the execution of built tasks, interaction with the webapp through internal "engine" APIs, as well as interfacing with things like docker or kubernetes, to execute the code.

## Public Packages

- <root>/packages/trigger-sdk is the `@trigger.dev/sdk` main SDK package.
- <root>/packages/cli-v3 is the `trigger.dev` CLI package. See our [CLI dev command](https://trigger.dev/docs/cli-dev.md) and [Deployment](https://trigger.dev/docs/deployment/overview.md) docs for more information.
- <root>/packages/core is the `@trigger.dev/core` package that is shared across the SDK and other packages
- <root>/packages/build defines the types and prebuilt build extensions for trigger.dev. See our [build extensions docs](https://trigger.dev/docs/config/extensions/overview.md) for more information.
- <root>/packages/react-hooks defines some useful react hooks like our realtime hooks. See our [Realtime hooks](https://trigger.dev/docs/frontend/react-hooks/realtime.md) and our [Trigger hooks](https://trigger.dev/docs/frontend/react-hooks/triggering.md) for more information.
- <root>/packages/redis-worker is the `@trigger.dev/redis-worker` package that implements a custom background job/worker sytem powered by redis for offloading work to the background, used in the webapp and also in the Run Engine 2.0.

## Internal Packages

- <root>/internal-packages/\* are packages that are used internally only, not published, and usually they have a tsc build step and are used in the webapp
- <root>/internal-packages/database is the `@trigger.dev/database` package that exports a prisma client, has the schema file, and exports a few other helpers.
- <root>/internal-packages/run-engine is the `@internal/run-engine` package that is "Run Engine 2.0" and handles moving a run all the way through it's lifecycle
- <root>/internal-packages/redis is the `@internal/redis` package that exports Redis types and the `createRedisClient` function to unify how we create redis clients in the repo. It's not used everywhere yet, but it's the preferred way to create redis clients from now on.
- <root>/internal-packages/testcontainers is the `@internal/testcontainers` package that exports a few useful functions for spinning up local testcontainers when writing vitest tests. See our [tests.md](./tests.md) file for more information.
- <root>/internal-packages/zodworker is the `@internal/zodworker` package that implements a wrapper around graphile-worker that allows us to use zod to validate our background jobs. We are moving away from using graphile-worker as our background job system, replacing it with our own redis-worker package.

## References

- <root>/references/\* are test workspaces that we use to write and test the system. Not quite e2e tests or automated, but just a useful place to help develop new features

## Other

- <root>/docs is our trigger.dev/docs mintlify documentation site
- <root>/docker/Dockerfile is the one that creates the main trigger.dev published image
- <root>/docker/docker-compose.yml is the file we run locally to start postgresql, redis, and electric when we are doing local development. You can run it with `pnpm run docker`
- <root>/CONTRIBUTING.md defines the steps it takes for OSS contributors to start contributing.
