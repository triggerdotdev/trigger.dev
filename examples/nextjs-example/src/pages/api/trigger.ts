import {
  customEvent,
  Job,
  NormalizedRequest,
  TriggerClient,
} from "@trigger.dev/sdk";
import { github } from "@trigger.dev/github";
import { slack } from "@trigger.dev/slack";
import type { NextApiRequest, NextApiResponse } from "next";
import { z } from "zod";

const gh = github({ id: "github" });
const sl = slack({ id: "my-slack-new" });

const client = new TriggerClient("nextjs", {
  apiKey: process.env.TRIGGER_API_KEY,
  apiUrl: "http://localhost:3000",
  endpoint: "http://localhost:3001/api/trigger",
  logLevel: "debug",
});

new Job({
  id: "comment-on-new-issues",
  name: "Comment on New GitHub issues",
  version: "0.1.1",
  logLevel: "debug",
  connections: {
    sl,
  },
  trigger: gh.triggers.onIssueOpened({
    repo: "ericallam/basic-starter-100k",
  }),
  run: async (event, io, ctx) => {
    await io.sl.postMessage("Slack 📝", {
      text: `New Issue opened: ${event.issue.html_url}`,
      channel: "C04GWUTDC3W",
    });
  },
}).attachTo(client);

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
