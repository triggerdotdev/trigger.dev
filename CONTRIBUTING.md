# Contributing to Trigger.dev

Thank you for taking the time to contribute to Trigger.dev. Your involvement is not just welcomed, but we encourage it! 🚀

Please take some time to read this guide to understand contributing best practices for Trigger.dev.

Thank you for helping us make Trigger.dev even better! 🤩

## Developing

The development branch is `main`. This is the branch that all pull
requests should be made against. The changes on the `main`
branch are tagged into a release periodically.

### Prerequisites

- [Node.js](https://nodejs.org/en) version 20.11.1
- [pnpm package manager](https://pnpm.io/installation) version 8.15.5
- [Docker](https://www.docker.com/get-started/)
- [protobuf](https://github.com/protocolbuffers/protobuf)

### Setup

1. Clone the repo into a public GitHub repository or [fork the repo](https://github.com/triggerdotdev/trigger.dev/fork). If you plan to distribute the code, keep the source code public to comply with the [Apache Licence 2.0](https://github.com/triggerdotdev/trigger.dev/blob/main/LICENSE).

   ```
   git clone https://github.com/<github_username>/trigger.dev.git
   ```

   > If you are on windows, run the following command on gitbash with admin privileges:
   > `git clone -c core.symlinks=true https://github.com/<github_username>/trigger.dev.git`

2. Navigate to the project folder
   ```
   cd trigger.dev
   ```
3. Ensure you are on the correct version of Node.js (20.11.1). If you are using `nvm`, there is an `.nvmrc` file that will automatically select the correct version of Node.js when you navigate to the repository.

4. Run `corepack enable` to use the correct version of pnpm (`8.15.5`) as specified in the root `package.json` file.

5. Install the required packages using pnpm.
   ```
   pnpm i
   ```
6. Create your `.env` file
   ```
   cp .env.example .env
   ```
7. Open it and generate a new value for `ENCRYPTION_KEY`:

   `ENCRYPTION_KEY` is used to two-way encrypt OAuth access tokens and so you'll probably want to actually generate a unique value, and it must be a random 16 byte hex string. You can generate one with the following command:

   ```sh
   openssl rand -hex 16
   ```

   Feel free to update `SESSION_SECRET` and `MAGIC_LINK_SECRET` as well using the same method.

8. Start Docker. This starts the required services like Postgres & Redis. If this is your first time using Docker, consider going through this [guide](DOCKER_INSTALLATION.md)

   ```
   pnpm run docker
   ```

9. Migrate the database
   ```
   pnpm run db:migrate
   ```
10. Build everything
    ```
    pnpm run build --filter webapp && pnpm run build --filter trigger.dev && pnpm run build --filter @trigger.dev/sdk
    ```
11. Run the app. See the section below.

## Running

1. You can run the app with:

   ```
   pnpm run dev --filter webapp
   ```

   It should run on port `3030`: [http://localhost:3030](http://localhost:3030/)

2. Once the app is running click the magic link button and enter your email. You will automatically be logged in, since you are running locally. Create an Org and your first project in the dashboard.

## Manual testing using v3-catalog

We use the `<root>/references/v3-catalog` subdirectory as a staging ground for testing changes to the SDK (`@trigger.dev/sdk` at `<root>/packages/trigger-sdk`), the Core package (`@trigger.dev/core` at `<root>packages/core`), the CLI (`trigger.dev` at `<root>/packages/cli-v3`) and the platform (The remix app at `<root>/apps/webapp`). The instructions below will get you started on using the `v3-catalog` for local development of Trigger.dev (v3).

### First-time setup

First, make sure you are running the webapp according to the instructions above. Then:

1. Visit http://localhost:3030 in your browser and create a new V3 project called "v3-catalog".

2. In Postgres go to the "Projects" table and for the project you create change the `externalRef` to `yubjwjsfkxnylobaqvqz`.

3. Build the CLI

```sh
# Build the CLI
pnpm run build --filter trigger.dev
# Make it accessible to `pnpm exec`
pnpm i
```

4. Change into the `<root>/references/v3-catalog` directory and authorize the CLI to the local server:

```sh
cd references/v3-catalog
cp .env.example .env
pnpm exec trigger login -a http://localhost:3030
```

This will open a new browser window and authorize the CLI against your local user account.

You can optionally pass a `--profile` flag to the `login` command, which will allow you to use the CLI with separate accounts/servers. We suggest using a profile called `local` for your local development:

```sh
cd references/v3-catalog
pnpm exec trigger login -a http://localhost:3030 --profile local
# later when you run the dev or deploy command:
pnpm exec trigger dev --profile local
pnpm exec trigger deploy --profile local
```

### Running

The following steps should be followed any time you start working on a new feature you want to test in v3:

1. Make sure the webapp is running on localhost:3030

2. Open a terminal window and build the CLI and packages and watch for changes

```sh
pnpm run dev --filter trigger.dev --filter "@trigger.dev/*"
```

3. Open another terminal window, and change into the `<root>/references/v3-catalog` directory.

4. You'll need to run the following commands to setup prisma and migrate the database:

```sh
pnpm exec prisma migrate deploy
pnpm run generate:prisma
```

5. Run the `dev` command, which will register all the local tasks with the platform and allow you to start testing task execution:

```sh
# in <root>/references/v3-catalog
pnpm exec trigger dev
```

If you want additional debug logging, you can use the `--log-level debug` flag:

```sh
# in <root>/references/v3-catalog
pnpm exec trigger dev --log-level debug
```

6. If you make any changes in the CLI/Core/SDK, you'll need to `CTRL+C` to exit the `dev` command and restart it to pickup changes. Any changes to the files inside of the `v3-catalog/src/trigger` dir will automatically be rebuilt by the `dev` command.

7. Navigate to the `v3-catalog` project in your local dashboard at localhost:3030 and you should see the list of tasks.

8. Go to the "Test" page in the sidebar and select a task. Then enter a payload and click "Run test". You can tell what the payloads should be by looking at the relevant task file inside the `/references/v3-catalog/src/trigger` folder. Many of them accept an empty payload.

9. Feel free to add additional files in `v3-catalog/src/trigger` to test out specific aspects of the system, or add in edge cases.

## Running end-to-end webapp tests (deprecated)

To run the end-to-end tests, follow the steps below:

1. Set up environment variables (copy example envs into the correct place)

```sh
cp ./.env.example ./.env
cp ./references/nextjs-test/.env.example ./references/nextjs-test/.env.local
```

2. Set up dependencies

```sh
# Build packages
pnpm run build --filter @references/nextjs-test^...
pnpm --filter @trigger.dev/database generate

# Move trigger-cli bin to correct place
pnpm install --frozen-lockfile

# Install playwrite browsers (ONE TIME ONLY)
npx playwright install
```

3. Set up the database

```sh
pnpm run docker
pnpm run db:migrate
pnpm run db:seed
```

4. Run the end-to-end tests

```sh
pnpm run test:e2e
```

### Cleanup

The end-to-end tests use a `setup` and `teardown` script to seed the database with test data. If the test runner doesn't exit cleanly, then the database can be left in a state where the tests can't run because the `setup` script will try to create data that already exists. If this happens, you can manually delete the `users` and `organizations` from the database using prisma studio:

```sh
# With the database running (i.e. pnpm run docker)
pnpm run db:studio
```

## Adding and running migrations

1. Modify internal-packages/database/prisma/schema.prisma file
2. Change directory to the packages/database folder

   ```sh
   cd packages/database
   ```

3. Create a migration

   ```
   pnpm run db:migrate:dev:create
   ```

   This creates a migration file. Check the migration file does only what you want. If you're adding any database indexes they must use `CONCURRENTLY`, otherwise they'll lock the table when executed.

4. Run the migration.

```
pnpm run db:migrate:deploy
pnpm run generate
```

This executes the migrations against your database and applies changes to the database schema(s), and then regenerates the Prisma client.

4. Commit generated migrations as well as changes to the schema.prisma file
5. If you're using VSCode you may need to restart the Typescript server in the webapp to get updated type inference. Open a TypeScript file, then open the Command Palette (View > Command Palette) and run `TypeScript: Restart TS server`.

## Add sample jobs

The [references/job-catalog](./references/job-catalog/) project defines simple jobs you can get started with.

1. `cd` into `references/job-catalog`
2. Create a `.env` file with the following content,
   replacing `<TRIGGER_DEV_API_KEY>` with an actual key:

```env
TRIGGER_API_KEY=[TRIGGER_DEV_API_KEY]
TRIGGER_API_URL=http://localhost:3030
```

`TRIGGER_API_URL` is used to configure the URL for your Trigger.dev instance,
where the jobs will be registered.

3. Run one of the the `job-catalog` files:

```sh
pnpm run events
```

This will open up a local server using `express` on port 8080. Then in a new terminal window you can run the trigger-cli dev command:

```sh
pnpm run dev:trigger
```

See the [Job Catalog](./references/job-catalog/README.md) file for more.

4. Navigate to your trigger.dev instance ([http://localhost:3030](http://localhost:3030/)), to see the jobs.
   You can use the test feature to trigger them.

## Making a pull request

**If you get errors, be sure to fix them before committing.**

- Be sure to [check the "Allow edits from maintainers" option](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/working-with-forks/allowing-changes-to-a-pull-request-branch-created-from-a-fork) while creating you PR.
- If your PR refers to or fixes an issue, be sure to add `refs #XXX` or `fixes #XXX` to the PR description. Replacing `XXX` with the respective issue number. See more about [Linking a pull request to an issue
  ](https://docs.github.com/en/issues/tracking-your-work-with-issues/linking-a-pull-request-to-an-issue).
- Be sure to fill the PR Template accordingly.

## Adding changesets

We use [changesets](https://github.com/changesets/changesets) to manage our package versions and changelogs. If you've never used changesets before, first read [their guide here](https://github.com/changesets/changesets/blob/main/docs/adding-a-changeset.md).

If you are contributing a change to any packages in this monorepo (anything in either the `/packages` or `/integrations` directories), then you will need to add a changeset to your Pull Requests before they can be merged.

To add a changeset, run the following command in the root of the repo

```sh
pnpm run changeset:add
```

Here's an example of creating a `patch` changeset for the `@trigger.dev/github` and `@trigger.dev/slack` packages (click to view):

[![asciicast](https://asciinema.org/a/599228.svg)](https://asciinema.org/a/599228)

You will be prompted to select which packages to include in the changeset. Only select the packages that you have made changes for.

Most of the time the changes you'll make are likely to be categorized as patch releases. If you feel like there is the need for a minor or major release of the package based on the changes being made, add the changeset as such and it will be discussed during PR review.

## Troubleshooting

### EADDRINUSE: address already in use :::3030

When receiving the following error message:

```sh
webapp:dev: Error: listen EADDRINUSE: address already in use :::3030
```

The process running on port `3030` should be destroyed.

1. Get the `PID` of the process running on PORT `3030`
   ```sh
   lsof -i :3030
   ```
2. Kill the process
   ```sh
   sudo kill -9 <PID>
   ```
