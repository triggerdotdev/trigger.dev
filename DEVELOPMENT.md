# Running a workflow locally

## After pulling

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
