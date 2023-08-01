## Example Job Catalog

This project is meant to be used to create a catalog of jobs, usually to test something in an integration or the SDK.

### Running

Each file in `src` is a separate set of jobs that can be run separately. For example, the `src/stripe.ts` file can be run with:

```sh
cd examples/job-catalog
pnpm run stripe
```

This will open up a local server using `express` on port 8080. Then in a new terminal window you can run the trigger-cli dev command:

```sh
cd examples/job-catalog
pnpm run trigger:dev
```

### Adding a new file

You can add a new file to `src` with it's own `TriggerClient` and set of jobs (e.g. `src/events.ts`)

```ts
import { TriggerClient, eventTrigger } from "@trigger.dev/sdk";
import { createExpressServer } from "@trigger.dev/express";
import { z } from "zod";

export const client = new TriggerClient({
  id: "job-catalog",
  apiKey: process.env["TRIGGER_API_KEY"],
  apiUrl: process.env["TRIGGER_API_URL"],
  verbose: false,
  ioLogLocalEnabled: true,
});

client.defineJob({
  id: "example-job-1",
  name: "Example Job 1",
  version: "0.1.0",
  trigger: eventTrigger({
    name: "example.one",
  }),
  run: async (payload, io, ctx) => {},
});

createExpressServer(client);
```

Then add a new script in [`package.json`](./package.json):

```json
{
  "scripts": {
    "events": "nodemon --watch src/events.ts -r tsconfig-paths/register -r dotenv/config src/events.ts"
  }
}
```
