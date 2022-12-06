# trigger.dev

Problem: Tools like Pipedream are great for quickly coding up a workflow that interacts with external services, but cannot easily access internal databases or internal services without opening them up to the internet or building proxies.

Solution: With Internal Workflow, your workflows are written in your existing codebase and run in your existing infrastructure, but are coordinated through the Internal Workflow service, making it easy to trigger workflows when external events happen and make authenticated requests to APIs.

## Examples

### GitHub issue sync

Let's start with a simple one: syncing GitHub issues to a database

```typescript
import { Workflow } from "@internal/workflows";
import { issues } from "@internal/github";

import { upsertIssue, deleteIssue } from "./db.server";

new Workflow({
  title: "Sync issues to internal database",
  version: "1.0.0",
  trigger: issues({ repo: "calcom/cal.com" }),
  run: async ({ action, data }, ctx, io) => {
    if (action === "deleted") {
      await deleteIssue(data.id);
    } else {
      await upsertIssue(data);
    }
  },
}).listen();
```

### Send welcome email, slack message, and add user to intercom when inserted into database

This workflow is a bit more complicated. It's triggered whenever a new record is INSERTed into the users table:

```typescript
import type { User } from "./db.server";
import { Workflow } from "@internal/workflow";
import { trigger } from "@internal/pg";
import { welcomeEmail } from "./emails";
import { updateUser } from "./db.server";

new Workflow({
  title: "Send Welcome Email to new users",
  version: "1.0.0",
  trigger: trigger<User>({
    table: "users",
    event: "INSERT",
  }),
  run: async (data, ctx, io) => {
    // Make sure the user is not a bot
    if (data.isBot) {
      return;
    }

    // Return if the user already received the welcome email
    if (data.emailSent) {
      return;
    }

    ctx.logger.info("Waiting for 30 minutes before sending the email", {
      user: data,
    });

    // Wait 30 minutes before sending the email
    await io.wait(30 * 60 * 1000);

    ctx.logger.info("Sending welcome email to new user", {
      user: data,
    });

    // Send the email through the email service
    await io.sendEmail({
      to: data.email,
      subject: "Welcome to our app!",
      body: welcomeEmail(data),
    });

    ctx.logger.info(`Sent welcome email to ${data.email}`);

    // Update the user to mark that the email was sent
    await updateUser(data.id, {
      emailSent: true,
    });

    await ctx.parallel([
      // Send a slack notification that the email was sent
      io.slack
        .sendMessage({
          text: `Welcome email sent to ${data.email}`,
        })
        .retry(3),
      // Save the user id on intercom
      io
        .fetch("intercom", {
          url: "https://api.intercom.io/users",
          method: "POST",
          body: JSON.stringify({
            user_id: data.id,
          }),
        })
        .retry(3),
    ]);
  },
}).listen();
```

## Development

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
3. Start the postgresql docker container

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
   **Running simply `pnpm run build` will build everything, including the NextJS app.**
7. Run the Remix dev server
   ```bash
   pnpm run dev --filter=webapp
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
