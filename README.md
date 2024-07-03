<div align="center">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://imagedelivery.net/3TbraffuDZ4aEf8KWOmI_w/a45d1fa2-0ae8-4a39-4409-f4f934bfae00/public">
  <source media="(prefers-color-scheme: light)" srcset="https://imagedelivery.net/3TbraffuDZ4aEf8KWOmI_w/3f5ad4c1-c4c8-4277-b622-290e7f37bd00/public">
  <img alt="Trigger.dev logo" src="https://imagedelivery.net/3TbraffuDZ4aEf8KWOmI_w/a45d1fa2-0ae8-4a39-4409-f4f934bfae00/public">
</picture>
  
### Open source background jobs with no timeouts

[Discord](https://trigger.dev/discord) | [Website](https://trigger.dev) | [Issues](https://github.com/triggerdotdev/trigger.dev/issues) | [Docs](https://trigger.dev/docs)

[![Twitter](https://img.shields.io/twitter/url/https/twitter.com/triggerdotdev.svg?style=social&label=Follow%20%40trigger.dev)](https://twitter.com/triggerdotdev)
[![GitHub Repo stars](https://img.shields.io/github/stars/triggerdotdev/trigger.dev?style=social)](https://github.com/triggerdotdev/trigger.dev)

</div>

> The Trigger.dev v3 developer preview is now open. For more information and to get early access, check out our [developer preview launch post](https://trigger.dev/blog/v3-developer-preview-launch/).

## About Trigger.dev

Trigger.dev is an open source platform and SDK which allows you to create long-running background jobs in your codebase. Write normal async code, deploy, and never hit a timeout.

#### Features:

- JavaScript and TypeScript SDK
- Write reliable code by default
- No infrastructure to manage
- Works with your existing tech stack

## Long-running tasks on serverless

Reliably run tasks and don’t worry about function timeouts, we handle those for you.

- Auto-resume after a function timeout
- Auto-resume after a server outage
- Add delays of up to a year

## In your codebase

Create tasks where they belong: in your codebase. Version control, localhost, test, review, and deploy like you're already used to.

```ts
import { task } from "@trigger.dev/sdk/v3";

//1. You need to export each task
export const helloWorld = task({
  //2. Use a unique id for each task
  id: "hello-world",
  //3. The run function is the main function of the task
  run: async (payload: { message: string }) => {
    //4. You can write code that runs for a long time here, there are no timeouts
    console.log(payload.message);
  },
});
```

## Deployment

Use our SDK to write tasks in your codebase. There's nothing extra to deploy and no CI to configure, your tasks just connect to our cloud. Or you can always self-host.

## Environments

We support `Development`, `Staging`, and `Production` environments, allowing you to test your tasks before deploying them to production.

## Full visibility of every job run

View every task in every run so you can tell exactly what happened. We provide a full trace view of every task run so you can see what happened at every step.

![Trace view image](https://imagedelivery.net/3TbraffuDZ4aEf8KWOmI_w/7c1b347f-004c-4482-38a7-3f6fa9c00d00/public)

# Getting started

Visit our docs [here](https://trigger.dev/docs/v3/introduction) for a full guide on how to get started with Trigger.dev.

## Self-host

If you prefer to self-host, you can follow our [self-hosting guide](https://trigger.dev/docs/v3/open-source-self-hosting#overview).

## Development

To setup and develop locally or contribute to the open source project, follow our [development guide](./CONTRIBUTING.md).

## Meet the Amazing People Behind This Project 🚀

<a href="https://github.com/triggerdotdev/trigger.dev/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=triggerdotdev/trigger.dev" />
</a>
