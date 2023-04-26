import {
  Job,
  TriggerClient,
  customEvent,
  NormalizedRequest,
} from "@trigger.dev/sdk";
import express from "express";
import { github } from "@trigger.dev/github";
import { z } from "zod";
import bodyParser from "body-parser";

const gh = github({ token: process.env.GITHUB_TOKEN! });

export const client = new TriggerClient("smoke-test", {
  apiUrl: "http://localhost:3000",
  endpoint: "http://localhost:3007/__trigger/entry",
  logLevel: "debug",
});

new Job({
  id: "my-job",
  name: "My Job",
  version: "0.0.1",
  logLevel: "debug",
  trigger: customEvent({ name: "smoke.text" }),
  run: async (event, io, ctx) => {
    await ctx.logger.debug("Inside the smoke test workflow, received event", {
      event,
      myDate: new Date(),
    });

    await ctx.wait("⏲", 10);

    await ctx.logger.debug("In between the two waits", {
      event,
      myDate: new Date(),
    });

    await ctx.sendEvent("Event 1", {
      name: "smoke.test",
      payload: { foo: "bar" },
      source: "smoke-test",
    });

    await ctx.wait("⏲⏲", 10);

    await ctx.sendEvent(
      "Event 2",
      {
        name: "smoke.test.delayed",
        payload: { foo: "bar", delayed: true },
        source: "smoke-test",
      },
      { deliverAfter: 30 }
    );

    return { foo: "bar" };
  },
}).registerWith(client);

new Job({
  id: "get-github-stars",
  name: "Get GitHub Stars",
  version: "0.0.1",
  logLevel: "debug",
  trigger: customEvent({
    name: "get.github.stars",
    schema: z.object({
      owner: z.string(),
      repo: z.string(),
    }),
  }),
  connections: {
    gh,
  },
  run: async (event, io, ctx) => {
    await ctx.logger.debug("Inside the github stars job", {
      event,
    });

    const repo = await io.gh.getRepo("Get Repo", {
      repo: `${event.owner}/${event.repo}`,
    });

    await ctx.logger.debug("Got response from GitHub", {
      repo,
    });

    return repo.stargazers_count;
  },
}).registerWith(client);

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

new Job({
  id: "do-stuff-on-issue-comment",
  name: "Doing something on GitHub issue comment",
  version: "0.1.1",
  logLevel: "debug",
  connections: {
    gh,
  },
  // issueEvent is a helper function that creates a trigger for a GitHub issue event webhook
  trigger: gh.onIssueComment({
    repo: "ericallam/basic-starter-100k",
  }),
  run: async (event, io, ctx) => {},
}).registerWith(client);

// Create an express app and listen on port 3007
const app = express();

app.use(express.json());
app.use(bodyParser.raw({ type: "application/octet-stream" }));

app.get("/__trigger/entry", expressHandler);
app.post("/__trigger/entry", expressHandler);

async function expressHandler(req: express.Request, res: express.Response) {
  const normalizedRequest = normalizeExpressRequest(req);

  const response = await client.handleRequest(normalizedRequest);

  if (!response) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  res.status(response.status).json(response.body);
}

app.listen(3007, async () => {
  console.log("Listening on port 3007");

  await client.listen();
});

// Converts a request from express to a request that can be passed to the
// TriggerClient, that any other type of request can be converted to.
// query is a Record<string, string>
// same with headers
function normalizeExpressRequest(req: express.Request): NormalizedRequest {
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
    method: req.method,
    query: normalizedQuery,
    url: req.url,
  };
}
