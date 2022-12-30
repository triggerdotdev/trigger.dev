# Initial setup

## Prerequisites

### Pulsar requirements

1. Ensure you have Homebrew installed by running `which brew` in terminal. If it's not found then you should install it: https://brew.sh/. Run `which brew` again to check it's found. If it's not you may need to [add it your path](https://stackoverflow.com/questions/36657321/after-installing-homebrew-i-get-zsh-command-not-found-brew)

2. Run `brew install libpulsar` to install the C++ libraries that the pulsar-client depends on

3. Make sure you have Python installed on your machine by running `which python3` in terminal.

4. If python isn't found then you should install it: https://www.python.org/downloads/. In a new terminal window run `which python3` again.

5. Run `npm config set python /the/path/from/the/which/python3/command` inserting the path from step 2 or 3

6. Install node-gyp: `npm install -g node-gyp`

7. Make sure you have the Xcode command line tools installed by running `xcode-select --install` from the terminal. If it says they're already installed then you're set.

8. Run this in the terminal:

```sh
export CPLUS_INCLUDE_PATH="$CPLUS_INCLUDE_PATH:$(brew --prefix)/include"
export LIBRARY_PATH="$LIBRARY_PATH:$(brew --prefix)/lib"
export PULSAR_CPP_DIR=/opt/homebrew/Cellar/libpulsar/3.1.0
```

9. Run `pnpm install` in the same terminal window.

## Building and running the webapp

> **Warning**
> All the following commands should be launched from the **monorepo root directory**

1. Install the dependencies.
   ```bash
   pnpm install
   ```
2. Environment variables. You will need to create copies of the `.env.example` files in `app/webapp`

   ```sh
   cp ./apps/webapp/.env.example ./apps/webapp/.env
   ```

   Then you will need to fill in the fields with real values.

   You also need to create three `.env` files under the `.docker` directory:

   ```sh
   cp ./.docker/pizzly-server.env.example ./.docker/pizzly-server.env
   cp ./.docker/pizzly_proxy.env.example ./.docker/pizzly_proxy.env
   cp ./.docker/webapp_proxy.env.example ./.docker/webapp_proxy.env
   ```

   In `webapp_proxy` and `pizzly_proxy` make sure you fill in the `NGROK_SUBDOMAIN` and `NGROK_AUTH` environment variables. For example, in `webapp_proxy` and `pizzly_proxy` you could have something like `dan-trigger-dev` and `dan-pizzly-dev` respectively for the `NGROK_SUBDOMAIN` env var.

   Next, update the `SERVER_HOST` env var in the `pizzly-server.env` env file with the value provided to the `NGROK_SUBDOMAIN` in the `pizzly_proxy.env` file. Using the example above the `SERVER_HOST` would be `SERVER_HOST=https://dan-pizzly-dev.ngrok.io`

   Also, in `webapp/.env`, set the `APP_ORIGIN` to the `NGROK_SUBDOMAIN` provided to the `webapp_proxy.env` file, e.g. `APP_ORIGIN=https://dan-trigger-dev.ngrok.io`

3. Start postgresql, pulsar, pizzly server, and the two ngrok proxies

   ```bash
   pnpm run docker:db
   ```

   > **Note:** The npm script will complete while Docker sets up the container in the background. Ensure that Docker has finished and your container is running before proceeding.

4. Generate prisma schema
   ```bash
   pnpm run generate
   ```
5. Run the Prisma migration to the database

   ```bash
   pnpm run db:migrate:deploy
   ```

6. Run the first build (with dependencies via the `...` option)

   ```bash
   pnpm run build --filter=webapp...
   ```

   **Running simply `pnpm run build` will build everything, including the Remix app.**

7. Run the Remix dev server

```bash
pnpm run dev --filter=webapp
```

## Attaching an API integration using Pizzly

```bash
PIZZLY_HOSTPORT=http://localhost:3004 npx pizzly config:create github github <client-id> <client-secret> "repo,user"
```

## Tests, Typechecks, Lint, Install packages...

Check the `turbo.json` file to see the available pipelines.

- Run the Cypress tests and Dev
  ```bash
  pnpm run test:e2e:dev --filter=webapp
  ```
- Lint everything
  ```bash
  pnpm run lint
  ```
- Typecheck the whole monorepo
  ```bash
  pnpm run typecheck
  ```
- Test the whole monorepo
  ```bash
  pnpm run test
  or
  pnpm run test:dev
  ```
- How to install an npm package in the Remix app ?
  ```bash
  pnpm add dayjs --filter webapp
  ```
- Tweak the tsconfigs, eslint configs in the `config-package` folder. Any package or app will then extend from these configs.

# Running a workflow locally

## After pulling a change

1. Ensure there are no database migrations to run

```bash
pnpm run db:migrate:dev
```

2. Generate the Prisma database client

```bash
pnpm run generate
```

3. Install packages

```bash
pnpm install
```

4. Build everything

```bash
pnpm run build
```

5. Install packages again, this makes sure the local packages are linked

```bash
pnpm install
```

## Running the servers

1. Ensure the docker containers are running

```bash
pnpm run docker:db
```

2. Run the webapp

```bash
pnpm run dev --filter=webapp
```

3. Run the coordinator

```bash
pnpm run dev --filter=coordinator
```

4. Run the @trigger.dev/sdk:dev

```bash
pnpm run dev --filter=@trigger.dev/sdk
```

## Running the smoke test

1. Run the smoke test workflow

```bash
cd ./examples/smoke-test
pnpm run dev
```

2. Running the workflow requires you to send data to the local API.

You can use this cURL command to send a `user.created` event. This will run the workflow and generate the corresponding logs.

```bash
curl --request POST \
  --url http://localhost:3000/api/v1/events \
  --header 'Authorization: Bearer trigger_dev_zC25mKNn6c0q' \
  --header 'Content-Type: application/json' \
  --data '{
	"name": "user.created",
	"payload": {
		"id": "123"
	}
}'
```

## Dependency & Package graph

![Dependency Graph](assets/dependencyGraph.png)
