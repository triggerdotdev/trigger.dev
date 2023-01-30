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
2. Optionally, if you are testing auth (pizzly) or webhooks (webapp) then you'll need to use ngrok to proxy internet traffic to your local machine

   Get access to ngrok and then follow the instructions here to get it setup: https://ngrok.com/download (use homebrew) and make sure to authenticate.

   Then run the following scripts to start proxying:

   ```sh
   ./scripts/proxy-pizzly.sh dan-pizzly-dev
   ./scripts/proxy-webapp.sh dan-trigger-dev
   ```

3. Environment variables. You will need to create copies of the `.env.example` files in `app/webapp`

   ```sh
   cp ./apps/webapp/.env.example ./apps/webapp/.env
   ```

   Then you will need to fill in the fields with real values.

   You also need to create the `pizzly-server.env` files under the `.docker` directory:

   ```sh
   cp ./.docker/pizzly-server.env.example ./.docker/pizzly-server.env
   ```

   Next, update the `AUTH_CALLBACK_URL` env var in the `pizzly-server.env` env file with the value provided to the `./scripts/proxy-pizzly.sh` command. Using the example above the `AUTH_CALLBACK_URL` would be `AUTH_CALLBACK_URL=https://dan-pizzly-dev.eu.ngrok.io/oauth/callback`.

   If you aren't proxying pizzly according to step 2, then leave the `pizzly-server.env` file empty.

   If you are proxying the webapp according to step 2 then in `webapp/.env`, set the `APP_ORIGIN` to the `NGROK_SUBDOMAIN` provided to the `./scripts/proxy-webapp.sh` command, e.g. `APP_ORIGIN=https://dan-trigger-dev.eu.ngrok.io`

4. Start postgresql, pulsar, and pizzly server

   ```bash
   pnpm run docker:db
   ```

   > **Note:** The npm script will complete while Docker sets up the container in the background. Ensure that Docker has finished and your container is running before proceeding.

5. Generate prisma schema
   ```bash
   pnpm run generate
   ```
6. Run the Prisma migration to the database

   ```bash
   pnpm run db:migrate:deploy
   ```

7. Run the first build (with dependencies via the `...` option)

   ```bash
   pnpm run build --filter=webapp...
   ```

   **Running simply `pnpm run build` will build everything, including the Remix app.**

8. Run the Remix dev server

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

3. Run the Web Socket Server

```bash
pnpm run dev --filter=wss
```

4. Build all the @trigger.dev/\* packages

```bash
pnpm run dev --filter="@trigger.dev/*"
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

## Warp Launch Configuration

Setup a custom launch configuration for the Warp terminal ([docs here](https://docs.warp.dev/features/sessions/launch-configurations)) by copying the `.warp/triggerdotdev.yaml.example` file to `~/.warp/launch_configurations/triggerdotdev.yaml`. Make sure you edit the file and replace `<your-trigger-dev>` and `<your-pizzly-dev>` with your custom ngrok subdomains.
