![Hero](https://raw.githubusercontent.com/triggerdotdev/trigger.dev/eebe37109e33beae6390ee19029fce8a5934c84b/apps/webapp/public/images/logo-banner.png)

[![Twitter](https://img.shields.io/twitter/url/https/twitter.com/triggerdotdev.svg?style=social&label=Follow%20%40trigger.dev)](https://twitter.com/triggerdotdev) ![YouTube Channel Subscribers](https://img.shields.io/youtube/channel/subscribers/UCu-PdxpWtIrrd7vW0N5T6ZA?style=social)
![GitHub Repo stars](https://img.shields.io/github/stars/triggerdotdev/trigger.dev?style=social)

# **Trigger.dev**

[Website](https://trigger.dev) | [Community](https://github.com/triggerdotdev/jsonhero-web) | [Docs](https://docs.trigger.dev)

Trigger.dev is an open source platform that makes it easy for developers to create event-driven background tasks directly in their code. Build, test and run workflows locally using our SDK. Subscribe to webhooks, schedule jobs, run background jobs and add long delays easily and reliably. In our web app you get full visibility of every run your workflow has ever made making it easier to monitor and debug.

&nbsp;

# **Features:**

- Easily subscribe to [webhooks](https://docs.trigger.dev/triggers/webhooks)
  —they work locally without tunnelling.
- Fire your own [custom events](https://docs.trigger.dev/triggers/custom-events)—a single event can trigger multiple workflows.
- [Schedule workflows](https://docs.trigger.dev/triggers/scheduled)—easily repeat tasks or use CRON syntax for advanced cases.
- Add [long delays](https://docs.trigger.dev/functions/delays) inside workflows (up to a year) and they will pick up where they left off.
- When your server goes down [it’s not a problem](https://docs.trigger.dev/guides/resumability), workflows will reconnect and continue.
- [View every step of every run](https://docs.trigger.dev/functions/viewing-runs), with data, previews and errors.
- Connect to and authenticate with APIs using our custom integrations.
- If you have a custom use case, we support [Fetch for calling any HTTP endpoint](https://docs.trigger.dev/functions/fetch) or [webhooks](https://docs.trigger.dev/triggers/webhooks) for subscribing to events from APIs.
- All API calls are automatically retried with exponential back off.
- TypeScript SDK, so whether you’re using JavaScript or TypeScript you will have a great experience.

&nbsp;

# **Documentation:**

- [Getting Started with Trigger.dev](https://docs.trigger.dev/getting-started)
- Example workflows
  - [Welcome email drip campaign using Resend and Slack](https://docs.trigger.dev/examples/resend)
  - [Post to Slack when a GitHub issue is created or modified](https://docs.trigger.dev/examples/slack)
  - [Create a new product on Shopify](https://docs.trigger.dev/examples/shopify)
  - [When a GitHub repo is starred, post information about the user to Slack](https://docs.trigger.dev/examples/github)
- Triggers:
  - [Webhooks](https://docs.trigger.dev/triggers/webhooks)
  - [Custom events](https://docs.trigger.dev/triggers/custom-events)
  - [Scheduled](https://docs.trigger.dev/triggers/scheduled)
- Functions:
  - [Fetch](https://docs.trigger.dev/functions/fetch)
  - [Logging](https://docs.trigger.dev/functions/logging)
  - [Delays](https://docs.trigger.dev/functions/delays)
  - [Send event](https://docs.trigger.dev/functions/send-event)
  - [Loops, conditionals, etc](https://docs.trigger.dev/functions/loops-conditionals-etc)

&nbsp;

# **Quick start guide**

### **1. Sign up at [trigger.dev](https://app.trigger.dev) and create a new organization.**

### **2. Install our SDK to your project:**

<Tabs>
  <Tab title="npm">

```bash
npm install @trigger.dev/sdk @trigger.dev/slack zod
```

  </Tab>
  <Tab title="pnpm">

```bash
pnpm install @trigger.dev/sdk @trigger.dev/slack zod
```

  </Tab>
  <Tab title="yarn">

```bash
yarn add @trigger.dev/sdk @trigger.dev/slack zod
```

  </Tab>
</Tabs>

### **3. Create a workflow file**

**Example workflows:**

<details open><summary> Post to Slack when a GitHub issue is created or modified
</summary>

_Integrations required: Slack, GitHub_

```ts
import { Trigger } from "@trigger.dev/sdk";
import * as github from "@trigger.dev/github";
import * as slack from "@trigger.dev/slack";

new Trigger({
  id: "new-github-star-to-slack",
  name: "New GitHub Star: triggerdotdev/trigger.dev",
  apiKey: "<my_api_key>",
  on: github.events.newStarEvent({
    repo: "triggerdotdev/trigger.dev",
  }),
  run: async (event) => {
    await slack.postMessage("github-stars", {
      channelName: "github-stars",
      text: `New GitHub star from \n<${event.sender.html_url}|${event.sender.login}>`,
    });
  },
}).listen();
```

</details>

<details><summary>Welcome email drip campaign
</summary>

_Integrations required: Slack, Resend_

```ts
import { customEvent, Trigger, sendEvent } from "@trigger.dev/sdk";
import * as resend from "@trigger.dev/resend";
import * as slack from "@trigger.dev/slack";
import React from "react";
import { z } from "zod";
import { getUser } from "../db";
import { InactiveEmail, TipsEmail, WelcomeEmail } from "./email-templates";

new Trigger({
  id: "welcome-email-campaign",
  name: "Welcome email drip campaign",
  apiKey: "<my_api_key>",
  on: customEvent({
    name: "user.created",
    schema: z.object({
      userId: z.string(),
    }),
  }),
  async run(event, context) {
    //get the user data from the database
    const user = await getUser(event.userId);

    await slack.postMessage("send-to-slack", {
      channelName: "new-users",
      text: `New user signed up: ${user.name} (${user.email})`,
    });

    //Send the first email
    const welcomeResponse = await resend.sendEmail("welcome-email", {
      from: "Trigger.dev <james@email.trigger.dev>",
      replyTo: "James <james@trigger.dev>",
      to: user.email,
      subject: "Welcome to Trigger.dev",
      react: <WelcomeEmail name={user.name} />,
    });
    await context.logger.debug(
      `Sent welcome email to ${welcomeResponse.to} with id ${welcomeResponse.id}`
    );

    //wait 1 day, check if the user has created a workflow and send the appropriate email
    await context.waitFor("wait-a-while", { days: 1 });
    const updatedUser = await getUser(event.userId);

    if (updatedUser.hasOnboarded) {
      await resend.sendEmail("onboarding-complete", {
        from: "Trigger.dev <james@email.trigger.dev>",
        replyTo: "James <james@trigger.dev>",
        to: updatedUser.email,
        subject: "Pro tips for workflows",
        react: <TipsEmail name={updatedUser.name} />,
      });
    } else {
      await resend.sendEmail("onboarding-incomplete", {
        from: "Trigger.dev <james@email.trigger.dev>",
        replyTo: "James <james@trigger.dev>",
        to: updatedUser.email,
        subject: "Help with your first workflow",
        react: <InactiveEmail name={updatedUser.name} />,
      });
    }
  },
}).listen();
```

</details>

[More examples here](https://docs.trigger.dev/examples/examples)

### **4. Sign in to your Trigger.dev dashboard and get your API keys**

- Go to [trigger.dev](https://app.trigger.dev) and login to your account.
- In the bottom-left corner of an Organization page you can find your API keys.
- Copy the API key for the organization you want to use and add it to your workflow file.

### **5. Test your workflow**

Move to the "Test" page and input a valid test event, remember the workflow expects the types you have defined in the schema.

Hit the "Run test" button and it will take us to our first run 🚀!

### **6. The run page**

All of the steps in a workflow, including the initial event, can be viewed in detail. You will need to refresh the page if it's running to see it move between steps.

### **7. Authenticating integrations**

When a workflow step uses an API integration that you haven't already authenticated with, it will pause until you've authenticated.

Simply click the "Connect to [integration]" button and sign-in with your desired Slack workspace. As soon as you do, the workflow will pick up where it left off.

Test complete!

### **8. Triggering this workflow from code**

As this workflow uses a custom event, we need to manually trigger it from our code. Anywhere in your code you can do this:

```ts
import { sendEvent } from "@trigger.dev/sdk";

/*
...your other code
*/

await sendEvent(uuidv4(), {
  name: "user.created"
  payload: {
    name: "Eleven",
    email: "jane@hawksmoorhigh.edu",
    paidPlan: true,
  },
});
```

&nbsp;

# **Running Trigger.dev locally:**

To run Trigger.dev locally, [follow these steps](https://github.com/triggerdotdev/trigger.dev/blob/main/DEVELOPMENT.md).

&nbsp;

# **Contributing:**

We are open source and love contributions!

- Request a feature in our [Discord community](https://discord.gg/JtBAxBr2m3)
- Open a PR

&nbsp;

# **Self-hosting guide:**

_coming soon..._

&nbsp;

# **Support & contact:**

- Join our [Discord community](https://discord.gg/JtBAxBr2m3)
- If you have any other questions, get in touch at [hello@trigger.dev](mailto:hello@trigger.dev)
