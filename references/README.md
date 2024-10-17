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

1. **Run the webapp on localhost**:

```
pnpm run dev --filter webapp --filter coordinator --filter docker-provider
```

2. **Build the CLI in a new terminal window**:

```
# Build the CLI
pnpm run build --filter trigger.dev

# Make it accessible to `pnpm exec`
pnpm i
```

3. **Set up a new project in the webapp**:
- Open the webapp running on `localhost:3030`.
- Create a new project in the webapp UI.
- Go to the *Project Settings* page and copy the project reference id from there.

4. **Copy the hello-world project as a template**:

```
cp -r references/hello-world references/<new-project>
```

Replace `<new-project>` with your desired project name.

5. **Update project details**:
- Open `<new-project>/package.json` and change the name field.
*(Tip: Use the same name as in the webapp to avoid confusion.)*

- Open `<new-project>/trigger.config.ts` and update the project field with the project reference you copied from the webapp.

6. **Authorize the CLI for your project**:

```
pnpm exec trigger login -a http://localhost:3030 --profile local
```

7. **Run the new project**:
You can now run your project using the CLI with the following command:

```
pnpm exec trigger dev --profile local
```
