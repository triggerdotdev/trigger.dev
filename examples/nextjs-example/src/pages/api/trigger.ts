import {
  comboTrigger,
  customEvent,
  customTrigger,
  DynamicTrigger,
  Job,
  NormalizedRequest,
  TriggerClient,
} from "@trigger.dev/sdk";
import { github, events } from "@trigger.dev/github";
import { slack as slackConnection } from "@trigger.dev/slack";
import type { NextApiRequest, NextApiResponse } from "next";
import { z } from "zod";

const gh = github({ id: "github" });
const slack = slackConnection({ id: "my-slack-new" });

const client = new TriggerClient("nextjs", {
  apiKey: process.env.TRIGGER_API_KEY,
  apiUrl: "http://localhost:3000",
  endpoint: "http://localhost:3001/api/trigger",
  logLevel: "debug",
});

const dynamicOnIssueOpenedTrigger = new DynamicTrigger(client, {
  id: "github-issue-opened",
  event: events.onIssueOpened,
  source: gh.sources.repo,
});

const dynamicOnIssueOpenedTriggerOrg = new DynamicTrigger(client, {
  id: "github-issue-opened-org",
  event: events.onIssueOpened,
  source: gh.sources.org,
});

dynamicOnIssueOpenedTrigger.register({
  repo: "ericallam/basic-starter-100k",
});

dynamicOnIssueOpenedTriggerOrg.register({
  org: "triggerdotdev",
});

new Job(client, {
  id: "alert-on-new-github-issues",
  name: "Alert on new GitHub issues",
  version: "0.1.1",
  connections: {
    slack,
  },
  trigger: gh.triggers.repo({
    event: events.onIssueOpened,
    repo: "ericallam/basic-starter-100k",
  }),
  run: async (event, io, ctx) => {
    await io.slack.postMessage("Slack 📝", {
      text: `New Issue opened: ${event.issue.html_url}`,
      channel: "C04GWUTDC3W",
    });
  },
});

new Job(client, {
  id: "alert-on-new-github-issues-dynamic",
  name: "Alert on new GitHub issues Dynamic",
  version: "0.1.1",
  trigger: dynamicOnIssueOpenedTrigger,
  run: async (event, io, ctx) => {},
});

new Job(client, {
  id: "alert-on-new-github-stars",
  name: "Alert on new GitHub stars",
  version: "0.1.1",
  trigger: gh.triggers.repo({
    event: events.onNewStar,
    repo: "ericallam/basic-starter-100k",
  }),
  run: async (event, io, ctx) => {},
});

new Job(client, {
  id: "alert-on-new-github-stars-in-org",
  name: "Alert on new GitHub stars in Org",
  version: "0.1.1",
  trigger: gh.triggers.org({
    event: events.onNewStar,
    org: "triggerdotdev",
  }),
  run: async (event, io, ctx) => {},
});

new Job(client, {
  id: "alert-on-new-github-stars-in-org",
  name: "Alert on new GitHub stars in Org",
  version: "0.1.1",
  trigger: comboTrigger({
    event: events.onNewStar,
    triggers: [
      gh.triggers.org({
        event: events.onNewStar,
        org: "triggerdotdev",
      }),
      gh.triggers.org({
        event: events.onNewStar,
        org: "jsonheroio",
      }),
    ],
  }),
  run: async (event, io, ctx) => {},
});

new Job(client, {
  id: "custom-event-example",
  name: "Custom Event Example",
  version: "0.1.1",
  trigger: customTrigger({
    name: "my.custom.trigger",
    event: customEvent({ schema: z.object({ id: z.string() }) }),
  }),
  run: async (event, io, ctx) => {},
});

new Job(client, {
  id: "custom-github-event-example",
  name: "Custom Github Event Example",
  version: "0.1.1",
  trigger: customTrigger({
    name: "my.custom.trigger",
    event: events.onNewStar,
  }),
  run: async (event, io, ctx) => {},
});

// new Job(client, {
//   id: "alert-on-new-github-stars",
//   name: "Alert on new GitHub stars",
//   version: "0.1.1",
//   trigger: customTrigger({
//     name: "my.custom.trigger",
//     event: events.onNewStar,
//   }),
//   run: async (event, io, ctx) => {},
// });

// new Job(client, {
//   id: "alert-on-new-github-stars",
//   name: "Alert on new GitHub stars",
//   version: "0.1.1",
//   trigger: customTrigger({
//     name: "other.custom.trigger",
//     event: eventFromZodSchema(z.object({ id: z.string() })),
//   }),
//   run: async (event, io, ctx) => {},
// });

// const notifySlackONNewCommentsJob = new Job({
//   id: "notify-slack-on-new-comments",
//   name: "Notify Slack on new GitHub comments",
//   version: "0.1.1",
//   logLevel: "debug",
//   connections: {
//     gh,
//     sl,
//   },
//   trigger: gh.triggers.onIssueComment({
//     repo: "ericallam/basic-starter-100k",
//   }),
//   run: async (event, io, ctx) => {
//     await io.sl.postMessage("Slack 📝", {
//       text: `New Comment on Issue: ${event.comment.html_url}`,
//       channel: "C04GWUTDC3W",
//     });
//   },
// })
//   .registerWith(client)
//   .addTriggerVariant(
//     "ericallam/hello-world",
//     gh.triggers.onIssueComment({
//       repo: "ericallam/hello-world",
//     })
//   );

// new Job({
//   id: "initialize-github-repo",
//   name: "Initialize GitHub Repo",
//   version: "0.1.1",
//   logLevel: "debug",
//   connections: {
//     gh,
//     sl,
//   },
//   trigger: customEvent({
//     name: "repo.created",
//     schema: z.object({
//       repo: z.string(),
//     }),
//   }),
//   run: async (event, io, ctx) => {
//     await io.addTriggerVariant(
//       notifySlackONNewCommentsJob,
//       event.repo,
//       gh.triggers.onIssueComment({
//         repo: event.repo,
//       })
//     );
//   },
// }).registerWith(client);

// const waitForEventInJob = new Job({
//   id: "wait-for-event-in-job",
//   name: "Wait for event in job",
//   version: "0.1.1",
//   logLevel: "debug",
//   trigger: customEvent({
//     name: "my-custom-event",
//     source: "my-source",
//     filter: {
//       foo: ["bar"],
//     },
//     schema: z.object({
//       foo: z.string(),
//     }),
//   }),
//   run: async (event, io, ctx) => {
//     const payload = await io.on(
//       "Wait for another event",
//       customEvent({
//         name: "my-custom-event-2",
//         source: "my-source",
//         schema: z.object({
//           foo: z.string(),
//         }),
//       })
//     );

//     return payload;
//   },
// }).registerWith(client);

// client.addTriggerVariant(
//   waitForEventInJob,
//   "custom-event-3",
//   customEvent({
//     name: "my-custom-event-3",
//     source: "my-source",
//     schema: z.object({
//       foo: z.string(),
//     }),
//   })
// );

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const normalizedRequest = normalizeRequest(req);

  const response = await client.handleRequest(normalizedRequest);

  if (!response) {
    res.status(404).json({ error: "Not found" });

    return;
  }

  res.status(response.status).json(response.body);
}

function normalizeRequest(req: NextApiRequest): NormalizedRequest {
  const normalizedHeaders = Object.entries(req.headers).reduce(
    (acc, [key, value]) => {
      acc[key] = value as string;
      return acc;
    },
    {} as Record<string, string>
  );

  const normalizedQuery = Object.entries(req.query).reduce(
    (acc, [key, value]) => {
      acc[key] = value as string;
      return acc;
    },
    {} as Record<string, string>
  );

  return {
    body: req.body,
    headers: normalizedHeaders,
    method: req.method ?? "GET",
    query: normalizedQuery,
    url: req.url ?? "/",
  };
}
