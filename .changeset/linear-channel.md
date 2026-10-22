---
"@trigger.dev/linear": minor
"@trigger.dev/sdk": minor
---

Add `@trigger.dev/linear`: turn a `chat.agent` into a Linear agent. Assign it an issue or @mention it, and Linear's agent session becomes a durable Trigger.dev session: the reply posts back to Linear, tool calls show as activities, `linearPlanTool()` keeps the plan Linear shows as a checklist, and approvals are Approve and Deny options that resume the run.

```ts
import { linear, webhookSource } from "@trigger.dev/linear";

const linearEvents = webhooks.endpoint.define({ id: "linear", source: webhookSource() });

export const triage = chat.agent({
  id: "triage",
  channels: [
    linear({ id: "linear", endpoint: linearEvents, token: process.env.LINEAR_ACCESS_TOKEN! }),
  ],
  run: async ({ messages, signal, streamText }) =>
    streamText({ model, messages, abortSignal: signal }),
});
```

The first turn gets the issue's context and earlier comments, images and PDFs in the issue reach the model, a Stop in Linear winds the turn down, and `errorMessage` sets the text a failed turn shows.
