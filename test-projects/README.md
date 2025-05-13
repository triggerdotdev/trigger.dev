## Trigger.dev References

Contains code that tests or uses the `@trigger.dev/*` packages in some way, either by using them to test out a framework adapter, an integration, or parts of the main SDK.

All the dependencies to the `@trigger.dev/*` packages will be both referenced in the package.json `dependencies` as `workspace:*`, as well as using a direct path from the tsconfig.json file like so:

```json
{
  "extends": "@trigger.dev/tsconfig/node18.json",
  "include": ["./src/**/*.ts"],
  "compilerOptions": {
    "baseUrl": ".",
    "lib": ["DOM", "DOM.Iterable"],
    "paths": {
      "@/*": ["./src/*"],
      "@trigger.dev/sdk": ["../../packages/trigger-sdk/src/index"],
      "@trigger.dev/sdk/*": ["../../packages/trigger-sdk/src/*"],
      "@trigger.dev/express": ["../../packages/express/src/index"],
      "@trigger.dev/express/*": ["../../packages/express/src/*"],
      "@trigger.dev/core": ["../../packages/core/src/index"],
      "@trigger.dev/core/*": ["../../packages/core/src/*"],
      "@trigger.dev/integration-kit": ["../../packages/integration-kit/src/index"],
      "@trigger.dev/integration-kit/*": ["../../packages/integration-kit/src/*"],
      "@trigger.dev/github": ["../../integrations/github/src/index"],
      "@trigger.dev/github/*": ["../../integrations/github/src/*"],
      "@trigger.dev/slack": ["../../integrations/slack/src/index"],
      "@trigger.dev/slack/*": ["../../integrations/slack/src/*"],
      "@trigger.dev/openai": ["../../integrations/openai/src/index"],
      "@trigger.dev/openai/*": ["../../integrations/openai/src/*"],
      "@trigger.dev/resend": ["../../integrations/resend/src/index"],
      "@trigger.dev/resend/*": ["../../integrations/resend/src/*"],
      "@trigger.dev/typeform": ["../../integrations/typeform/src/index"],
      "@trigger.dev/typeform/*": ["../../integrations/typeform/src/*"],
      "@trigger.dev/plain": ["../../integrations/plain/src/index"],
      "@trigger.dev/plain/*": ["../../integrations/plain/src/*"],
      "@trigger.dev/supabase": ["../../integrations/supabase/src/index"],
      "@trigger.dev/supabase/*": ["../../integrations/supabase/src/*"],
      "@trigger.dev/stripe": ["../../integrations/stripe/src/index"],
      "@trigger.dev/stripe/*": ["../../integrations/stripe/src/*"],
      "@trigger.dev/sendgrid": ["../../integrations/sendgrid/src/index"],
      "@trigger.dev/sendgrid/*": ["../../integrations/sendgrid/src/*"],
      "@trigger.dev/airtable": ["../../integrations/airtable/src/index"],
      "@trigger.dev/airtable/*": ["../../integrations/airtable/src/*"]
    }
  }
}
```

### Creating a New Reference Project

This guide assumes that you have followed the [Contributing.md](https://github.com/triggerdotdev/trigger.dev/blob/main/CONTRIBUTING.md#setup) instructions to set up a local trigger.dev instance. If not, please complete the setup before continuing.

#### Step-by-Step Instructions

1. **Run an HTTP tunnel**:
   You will need to run an HTTP tunnel to expose your local webapp, it is required for some API calls during building the image to deploy on your local instance. This is _optional_ if you do not plan to test deployment on your local instance.

- Download the ngrok CLI. This can be done by following the instructions on ngrok's [website](https://ngrok.com/docs/getting-started/).
- Create an account on ngrok to obtain the authtoken and add it to the CLI.

```bash
ngrok config add-authtoken <your-auth-token>
```

Replace the <your-auth-token> with the token you obtain from ngrok.

- Run the tunnel.

```bash
ngrok http <your-app-port>
```

Replace the <your-app-port> with the webapp port, default is `3030`.

2. **Add your tunnel URL to the env**:
   After running the ngrok tunnel, you will see URL in your terminal, it will look something like `https://<your-tunnel-address>.ngrok-free.app`.
   Replace the `APP_ORIGIN` variable with this URL in your `.env` file in the root of the trigger.dev project.

3. **Run the webapp on localhost**:

```bash
pnpm run dev --filter webapp --filter coordinator --filter docker-provider
```

4. **Build the CLI in a new terminal window**:

```bash
# Build the CLI
pnpm run build --filter trigger.dev

# Make it accessible to `pnpm exec`
pnpm i
```

5. **Set up a new project in the webapp**:

- Open the webapp running on `localhost:3030`.
- Create a new project in the webapp UI.
- Go to the _Project Settings_ page and copy the project reference id from there.

6. **Copy the hello-world project as a template**:

```bash
cp -r test-projects/hello-world test-projects/<new-project>
```

Replace `<new-project>` with your desired project name.

7. **Update project details**:

- Open `<new-project>/package.json` and change the name field.
  _(Tip: Use the same name as in the webapp to avoid confusion.)_

- Open `<new-project>/trigger.config.ts` and update the project field with the project reference you copied from the webapp.

- Run `pnpm i` in your `<new-project>` directory to sync the dependencies.

8. **Authorize the CLI for your project**:

```bash
pnpm exec trigger login -a http://localhost:3030 --profile local
```

9. **Run the new project**:
   You can now run your project using the CLI with the following command:

```bash
pnpm exec trigger dev --profile local
```

You can also deploy them against your local instance with the following command:

```bash
pnpm exec trigger deploy --self-hosted --load-image --profile local
```
