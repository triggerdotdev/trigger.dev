# The v3 catalog

You can test v3 tasks from inside the app in this project. It's designed to be used for testing features and functionality of the v3 SDK.

## One-time setup

1. Create a v3 project in the UI of the webapp, you should now be able to select it from the dropdown.

2. In Postgres go to the "Projects" table and for the project you create change the `externalRef` to `yubjwjsfkxnylobaqvqz`.

This is so the `trigger.config.ts` file inside the v3-catalog doesn't keep getting changed by people accidentally pushing this.

## How to use

1. Make sure you're running the main webapp

```bash
pnpm run dev --filter webapp
```

2. Build the v3 CLI (this needs to be done everytime a code changes is made to the CLI if you're working on it)

```bash
pnpm run build --filter trigger.dev
```

3. CD into the v3-catalog directory

```bash
cd references/v3-catalog
```

4. If you've never logged in to the CLI you'll see an error telling you to login. Do this:

```bash
pnpm exec trigger login -a http://localhost:3030
```

If this fails because you already are logged in you can create a new profile:

```bash
pnpm exec trigger login -a http://localhost:3030 --profile local
```

Note: if you use a profile then you'll need to append `--profile local` to all commands, like `dev`.

5. Run the v3 CLI

```bash
pnpm exec trigger dev
```

6. You should see the v3 dev command spitting out messages, including that it's started a background worker.

7. Go to the webapp now and inside your project you should see some tasks on the "Tasks" page.

8. Go to the "Test" page in the sidebar and select a task. Then enter a payload and click "Run test". You can tell what the payloads should be by looking at the relevant task file inside the `/references/v3-catalog/src/trigger` folder. Many of them accept an empty payload.
