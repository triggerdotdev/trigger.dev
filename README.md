![Logo](https://trigger.dev/_next/static/media/triggerdotdev-logo.9226e5d0.png?imwidth=256)

[![Twitter Follow](https://img.shields.io/twitter/follow/triggerdotdev)](https://twitter.com/intent/follow?screen_name=triggerdotdev)

# ⚙️ Automate complex workflows with code

Trigger workflows from APIs, on a schedule, or on demand. API calls are easy with authentication handled for you. Add durable delays that survive server restarts.

![Hero](https://trigger.dev/_next/static/media/hero-image.4c367bbf.png?imwidth=1920)

# 💻 Developer-first features

## In your codebase

Trigger.dev is code-first so you can create workflows where they belong: in your codebase. Version control, localhost, test, review, and deploy like you're used to.

## Secure by design

Your workflows run on your servers, not ours. We only receive the data you choose to send to us.

&nbsp;

# Hundreds of Integrations

Subscribe to API changes and make requests, we’ll handle authentication for you.

&nbsp;

# 🚀 Workflow examples

## 🔄 Sync GitHub issues to Linear

![GitHub](https://img.shields.io/badge/-GitHub-gray) ![Linear](https://img.shields.io/badge/-Linear-blue)

Triggered when a GitHub issue is created or updated. Query your database to map GitHub user ids to Linear user ids. Then create or update Linear issues.",

```Typescript

import { Trigger, github, linear } from "@trigger.dev/sdk";

new Trigger({
name: "Sync Github issues to Linear",
on: github.issueEvent({
    repo: "acme/website",
}),
run: async (event, ctx) => {
    const { issue, action } = event;

    // Find the user in our local database
    const assignee = await findUserByGithubId(issue.assignee?.id);

    if (action === "opened") {
    await linear.issueCreate({
        id: issue.id,
        title: issue.title,
        description: issue.body,
        assigneeId: assignee?.linearId,
        teamId: ctx.env.LINEAR_TEAM_ID,
    });
    } else {
    await linear.issueUpdate(issue.id, {
        assigneeId: assignee?.linearId,
        stateId:
        action === "closed"
            ? ctx.env.LINEAR_CLOSED_STATE_ID
            : ctx.env.LINEAR_OPEN_STATE_ID,
    });
    }
},
}).listen();

```

&nbsp;

## ✉️ Send emails to new users

![User](https://img.shields.io/badge/-User-gray) ![Email](https://img.shields.io/badge/-Email-gray) ![Slack](https://img.shields.io/badge/-Slack-purple)

Triggered on demand by your other code when a user is created. We wait for 3 hours then send a follow-up email if the user hasn’t completed onboarding yet.

```Typescript
import { Trigger, customEvent, slack, mailgun } from "@trigger.dev/sdk";

new Trigger({
  name: "Send Email to New Users",
  on: customEvent<UserEvent>({ name: "user.created" }),
  run: async (event, ctx) => {
    // Wait for 3 hours before continuing
    await ctx.waitFor({ hours: 3 });

    // Lookup user in the database
    const user = await findUserById(event.id);

    // only send email if user has not onboarded
    if (!user.hasOnboarded) {
      await mailgun.send({
        to: user.email,
        subject: "Welcome to our app!",
        body: `Welcome to our app ${user.name}!}`,
      });

      await slack.sendMessage({
        text: `Welcome email sent to ${user.email}`,
      });
    } else {
      await slack.sendMessage({
        text: `User ${user.email} has already onboarded`,
      });
    }
  },
}).listen();
```

&nbsp;

## 🚨 Escalate critical incidents

![Intercom](https://img.shields.io/badge/-Intercom-blue) ![Linear](https://img.shields.io/badge/-Linear-blue) ![Slack](https://img.shields.io/badge/-Slack-purple) ![PagerDuty](https://img.shields.io/badge/-PagerDuty-green)

Triggered when an Intercom incident happens. We create a Linear issue, send a Slack message and, if it’s an urgent incident, we alert whoever is on call.

```Typescript
import { Trigger, intercom, linear, slack, pagerduty } from "@trigger.dev/sdk";

new Trigger({
  name: "Intercom Incident",
  on: intercom.newIncident(),
  run: async (event, ctx) => {
    // Find the customer in the database
    const customer = await db.query("SELECT * FROM users WHERE email = $1", [
      event.email,
    ]);

    // Create linear ticket
    const ticket = await linear.issueCreate({
      title: event.title,
      description: event.description,
      assigneeId: ctx.env.LINEAR_ASSIGNEE_ID,
      teamId: ctx.env.LINEAR_TEAM_ID,
    });

    // notify account manager
    await slack.sendMessage({
      text: `New incident for ${customer.name} in Linear: ${ticket.url}`,
    });

    if (event.severity === "urgent") {
      // Create a pagerduty incident
      await pagerduty.createIncident({
        title: event.title,
        description: event.description,
        severity: "critical",
        serviceId: ctx.env.PAGERDUTY_SERVICE_ID,
      });
    }
  },
}).listen();
```

&nbsp;

# ⚡️ Trigger happy

Install our SDK and get instant access to an arsenal of triggers you can use in your code:


### **Webhooks**

Subscribe to webhooks without creating API endpoints. Plus they work locally without tunneling.

```Typescript
github.issueEvent({ repo: "acme/website" })
```


### **Scheduled (CRON)**

Easily subscribe to a recurring schedule using human readable code or CRON syntax.

```Typescript
scheduleEvent({ every: { minutes: 30 } })
```


### **Custom Events**

Trigger workflows from any event in your app. Send us your events, and we'll do the rest.

```Typescript
customEvent<YourType>({ name: "your.event" })
```

### **HTTP Endpoint**

Expose a HTTP endpoint to trigger your workflows with the method and path of your choice.

```Typescript
httpEvent<User>({ method: "POST", path: "/users/:id" })
```

### **Receive Emails**

Receive emails from your custom domain and trigger a workflow with the email metadata and content.

```Typescript
emailEvent({ address: "support@help.customdomain.io" })
```

### **AWS Event Bridge**

Integrate with AWS Event Bridge to trigger workflows on your own Event Bridge events.

```Typescript
eventBridge<SupportRequest>({ bus: "customer-support" })
```

&nbsp;

# 🔋 Batteries included

### **Debugging and visibility**

We provide a full history of all runs, so you can see exactly what happened.

&nbsp;

<img src="https://trigger.dev/_next/static/media/runs-diagram.c9ce4213.png" alt="Runs" width="400"/>

&nbsp;

---

&nbsp;

### **Survives downtime**

Workflows pick up where they left off when your server or external APIs go down.

&nbsp;

<img src="https://trigger.dev/_next/static/media/retries-diagram.d90a00d9.png
" alt="Retries" width="400"/>

&nbsp;

# Go from idea to production in minutes

## **1. Code**

Write workflows by creating triggers directly in your code. These can be 3rd-party integrations, custom events or on a schedule.

## **2. Connect**

When your server runs, your workflow will be registered and you can authenticate with any APIs you’re using.

## **3. Test**

When your server runs, your workflow will be registered and you can authenticate with any APIs you’re using.

## **3. Deploy**

Deploy your new workflow as you would any other code commit and inspect each workflow run in real time.

&nbsp;

# ✅ We ❤️ Open Source!

You’ll always be able to host and run Trigger.dev yourself.

We've also created [JSON Hero](https://github.com/triggerdotdev/jsonhero-web), an open source JSON viewer used by around 55,000 developers per month.

&nbsp;

# 🙋 FAQs

<details><summary> Does my data get sent to your servers?</summary><br>

Only what you choose to send. The main body of your workflow code runs on your infrastructure.
For example when you do a database query, that never touches us.

Data we will receive (and store to display on the Runs page in your dashboard):

- Any data that triggers the start of a workflow
- Any data you pass to one of our API integrations • Any data you choose to log using our logging function

</details>

<details><summary> How is this different to Zapier, Pipedream etc?</summary><br>

Trigger.dev is a code-first workflow tool that lets you create workflows directly in your code, rather than using a UI builder like Zapier. This means you can stay in your own IDE and keep your internal data secure.

</details>

<details><summary>How long does this take to set up?</summary><br>

Setting up Trigger.dev is simple and takes 2 minutes. Install our SDK to get started and check out the Getting Started documentation to start creating your first workflow.

</details>

<details><summary>Can I use version control or roll-backs?</summary><br>

Yes. You create workflows directly in your own code so it’s version controlled with everything else.

</details>

<details><summary>How long does it take to code up a workflow?</summary><br>

A simple workflow triggering two events from different services will take about 5 minutes to create.

</details>

<details><summary>Do you have all the integrations I need?</summary><br>

Probably. Trigger.dev includes over 100 integrations including the most popular services. If you need a specific service that’s not available, you can request it, or create it yourself. We’re open source, so create an issue or Pull Request.

</details>

<details><summary>Can I build complex workflows?</summary><br>

Yes. There’s no limit to the complexity on workflows you can create. Workflows are created in code so you can write conditional, looping, branching or time delayed logic.

</details>

<details><summary> Can I run Trigger.dev locally?</summary><br>

Yes. Workflows are created in your code locally and, unlike webhooks, you don’t need to use tunneling to receive triggers.

</details>

<details><summary>How does the pricing model work?</summary><br>

Our hosted product gives you free runs each month, after that you will need to select a paid tier. You can also self-host, view the open source repository for instructions.

</details>

<details><summary>Is Trigger.dev open source?</summary><br>

Yes, Trigger.dev is open source. We are strong supporters of open source software, and our first product, [jsonhero.io](https://jsonhero.io), has a thriving open source community. Trigger.dev follows in that tradition.

</details>

<details><summary>Is Trigger.dev a no/low-code tool?</summary><br>

No. Trigger.dev is designed for developers who want to create workflows directly in code, without using a UI builder like Zapier. This allows developers to stay in their familiar development environment and customise their workflows with code.

</details>

<details><summary>What languages / frameworks do you support?</summary><br>

Currently there is support for Node.js. More frameworks will be added soon.

</details>

<details><summary>Can I use an API which doesn’t have webhooks?</summary><br>

Yes. You can use a polling trigger to subscribe is no webhook exists.

</details>

<details><summary>Can non-coders use this product?</summary><br>

Developers will need to create workflows. Anyone on the team can monitor running workflows in the Trigger dashboard.

</details>
&nbsp;

---

&nbsp;

If you have any other questions about Trigger.dev, [drop us an email](mailto:hello@trigger.dev), and one of the founders will get back to you.
