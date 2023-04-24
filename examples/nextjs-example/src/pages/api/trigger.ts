import { Job, NormalizedRequest, TriggerClient } from "@trigger.dev/sdk";
import { github } from "@trigger.dev/github";
import type { NextApiRequest, NextApiResponse } from "next";
const gh = github({ token: process.env.GITHUB_TOKEN! });

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
  },
  // issueEvent is a helper function that creates a trigger for a GitHub issue event webhook
  trigger: gh.onIssueOpened({
    repo: "ericallam/basic-starter-100k",
  }),
  run: async (event, io, ctx) => {
    // event is a GitHubIssueEvent
    const comment = await io.gh.createIssueComment("📝", {
      repo: event.repository.full_name,
      issueNumber: event.issue.number,
      body: "Hello from Trigger!",
    });

    // const token = await ctx.auth.gh

    const reaction = await io.runTask(
      "Add 🚀",
      {
        icon: "github",
        name: "addReaction",
        elements: [
          { label: "reaction", text: "🚀" },
          {
            label: "issue",
            text: event.issue.title,
            url: event.issue.html_url,
          },
        ],
        delayUntil: new Date(Date.now() + 1000 * 30), // 30 seconds from now
      },
      async (task) =>
        io.gh.client.rest.reactions
          .createForIssueComment({
            owner: event.repository.owner.login,
            repo: event.repository.name,
            comment_id: comment.id,
            content: "rocket",
          })
          .then((res) => res.data)
    );

    return reaction;
  },
}).registerWith(client);

// export const config = {
//   api: {
//     bodyParser: false,
//   },
// };

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
