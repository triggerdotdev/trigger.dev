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

const gh = github({ token: process.env.GITHUB_TOKEN! });
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
    gh,
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

    await io.runTask(
      "Comment on Issue with a reaction",
      { name: "Parent Task" },
      async (task) => {
        const comment = await io.runTask(
          "Comment on issue",
          { name: "Comment on Issue" },
          async (t) => {
            return io.gh.client.rest.issues
              .createComment({
                owner: event.repository.owner.login,
                repo: event.repository.name,
                issue_number: event.issue.number,
                body: "Hello from Trigger!",
              })
              .then((res) => res.data);
          }
        );

        await io.runTask(
          "Add react to comment",
          { name: "Add reaction to comment" },
          async (t) => {
            return io.gh.client.rest.reactions.createForIssueComment({
              owner: event.repository.owner.login,
              repo: event.repository.name,
              comment_id: comment.id,
              content: "rocket",
            });
          }
        );

        return comment;
      }
    );

    await io.gh.createIssueCommentWithReaction("📝", {
      repo: `${event.repository.owner.login}/${event.repository.name}`,
      issueNumber: event.issue.number,
      body: "Hello from Trigger!",
      reaction: "rocket",
    });
  },
}).registerWith(client);

// TODO: Support parameterized jobs
// Example:
// const job = new Job({});
// await job.registerWith(client, { params: { foo: "bar" } });
// And registering as a specific user:
// await job.registerWith(client, { params: { foo: "bar" } }, { userId: "..." });

new Job({
  id: "wait-for-event-in-job",
  name: "Wait for event in job",
  version: "0.1.1",
  logLevel: "debug",
  trigger: customEvent({
    name: "my-custom-event",
    source: "my-source",
    filter: {
      foo: ["bar"],
    },
    schema: z.object({
      foo: z.string(),
    }),
  }),
  run: async (event, io, ctx) => {
    const payload = await io.on(
      "Wait for another event",
      customEvent({
        name: "my-custom-event-2",
        source: "my-source",
        schema: z.object({
          foo: z.string(),
        }),
      })
    );

    return payload;
  },
}).registerWith(client);

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

client.listen().catch(console.error);

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
