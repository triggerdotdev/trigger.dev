# @trigger.dev/slack

## 4.8.4

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@4.8.4`
  - `@trigger.dev/sdk@4.8.4`

## 4.8.3

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/sdk@4.8.3`
  - `@trigger.dev/core@4.8.3`

## 4.8.2

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/sdk@4.8.2`
  - `@trigger.dev/core@4.8.2`

## 4.8.1

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@4.8.1`
  - `@trigger.dev/sdk@4.8.1`

## 4.8.0

### Minor Changes

- Add `@trigger.dev/slack`: turn a `chat.agent` into a native Slack agent. Each DM or channel thread is a durable session, the reply streams into the thread with the turn's tool calls shown as a plan, approvals are Approve and Deny buttons, and Slack's stop button stops the turn. ([`6e715da77`](https://github.com/triggerdotdev/trigger.dev/commit/6e715da7709c48eedd134d52645d825b3569e0ff))

  ```ts
  import { appMentions, slack, webhookSource } from "@trigger.dev/slack";

  const slackEvents = webhooks.endpoint.define({
    id: "slack",
    source: webhookSource(),
  });

  export const support = chat.agent({
    id: "support",
    channels: [
      slack({
        id: "slack",
        endpoint: slackEvents,
        token: process.env.SLACK_BOT_TOKEN!,
        startOn: appMentions(),
      }),
    ],
    run: async ({ messages, signal, streamText }) =>
      streamText({ model, messages, abortSignal: signal }),
  });
  ```

  `startOn` decides which channel messages start a session (`appMentions()` answers when the agent is @mentioned). Images and PDFs people share reach the model, messages sent while the agent is answering can be folded into the reply, tools can post their own buttons, and `ownWorkspaceOnly` ignores Slack Connect guests.

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/sdk@4.8.0`
  - `@trigger.dev/core@4.8.0`
