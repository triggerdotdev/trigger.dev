import {
  comboTrigger,
  cronTrigger,
  customEvent,
  customTrigger,
  DynamicSchedule,
  DynamicTrigger,
  intervalTrigger,
  Job,
  missingConnectionNotification,
  missingConnectionResolvedNotification,
  NormalizedRequest,
  TriggerClient,
} from "@trigger.dev/sdk";
import { Github, events } from "@trigger.dev/github";
import { Slack } from "@trigger.dev/slack";
import type { NextApiRequest, NextApiResponse } from "next";
import { z } from "zod";

const github = new Github({ id: "github" });
const githubUser = new Github({ id: "github-user" });

// const githubLocal = new Github({
//   id: "github-local",
//   token: process.env.GITHUB_TOKEN,
// });

const slack = new Slack({ id: "my-slack-new" });

const client = new TriggerClient("nextjs", {
  apiKey: process.env.TRIGGER_API_KEY,
  apiUrl: "http://localhost:3000",
  endpoint: "http://localhost:3001/api/trigger",
  logLevel: "debug",
});

const dynamicOnIssueOpenedTrigger = new DynamicTrigger(client, {
  id: "github-issue-opened",
  event: events.onIssueOpened,
  source: github.sources.repo,
});

const dynamicUserTrigger = new DynamicTrigger(client, {
  id: "dynamic-user-trigger",
  event: events.onIssueOpened,
  source: githubUser.sources.repo,
});

const dynamicSchedule = new DynamicSchedule(client, {
  id: "dynamic-interval",
});

const enabled = true;

new Job(client, {
  id: "on-missing-auth-connection",
  name: "On missing auth connection",
  version: "0.1.1",
  enabled,
  trigger: missingConnectionNotification([githubUser]),
  integrations: {
    slack,
  },
  run: async (payload, io, ctx) => {
    switch (payload.type) {
      case "DEVELOPER": {
        return await io.slack.postMessage("message", {
          text: `Missing developer connection: ${JSON.stringify(payload)}`,
          channel: "C04GWUTDC3W",
        });
      }
      case "EXTERNAL": {
        return await io.slack.postMessage("message", {
          text: `Missing external connection: account: ${JSON.stringify(
            payload.account
          )}, payload: ${JSON.stringify(payload)}`,
          channel: "C04GWUTDC3W",
        });
      }
    }
  },
});

new Job(client, {
  id: "on-missing-auth-connection-resolved",
  name: "On missing auth connection-resolved",
  version: "0.1.1",
  enabled,
  trigger: missingConnectionResolvedNotification([githubUser]),
  integrations: {
    slack,
  },
  run: async (payload, io, ctx) => {
    switch (payload.type) {
      case "DEVELOPER": {
        return await io.slack.postMessage("message", {
          text: `Missing developer connection resolved: ${JSON.stringify(
            payload
          )}`,
          channel: "C04GWUTDC3W",
        });
      }
      case "EXTERNAL": {
        return await io.slack.postMessage("message", {
          text: `Missing external connection resolved: ${JSON.stringify(
            payload
          )}`,
          channel: "C04GWUTDC3W",
        });
      }
    }
  },
});

new Job(client, {
  id: "user-on-issue-opened",
  name: "user on issue opened",
  version: "0.1.1",
  enabled,
  trigger: dynamicUserTrigger,
  integrations: {
    github: githubUser,
  },
  run: async (payload, io, ctx) => {
    return await io.github.getRepo("get.repo", {
      repo: payload.repository.full_name,
    });
  },
});

new Job(client, {
  id: "get-user-repo",
  name: "Get User Repo",
  version: "0.1.1",
  enabled,
  trigger: customTrigger({
    name: "get.repo",
    event: customEvent({
      payload: z.object({
        repo: z.string(),
      }),
    }),
  }),
  integrations: {
    github: githubUser,
  },
  run: async (payload, io, ctx) => {
    await io.logger.info("This is a log info message", {
      payload,
    });

    return await io.github.getRepo("get.repo", payload);
  },
});

new Job(client, {
  id: "get-user-repo-on-schedule",
  name: "Get User Repo On Schedule",
  version: "0.1.1",
  enabled,
  trigger: dynamicSchedule,
  integrations: {
    github: githubUser,
  },
  run: async (payload, io, ctx) => {
    return await io.github.getRepo("get.repo", {
      repo: ctx.event.context.source.metadata.repo,
    });
  },
});

new Job(client, {
  id: "register-dynamic-interval",
  name: "Register Dynamic Interval",
  version: "0.1.1",
  enabled,
  trigger: customTrigger({
    name: "dynamic.interval",
    event: customEvent({
      payload: z.object({
        id: z.string(),
        seconds: z.number().int().positive(),
      }),
    }),
  }),
  run: async (payload, io, ctx) => {
    await io.registerInterval("📆", dynamicSchedule, payload.id, {
      seconds: payload.seconds,
    });

    await io.wait("wait", 60);

    await io.unregisterInterval("❌📆", dynamicSchedule, payload.id);
  },
});

new Job(client, {
  id: "register-dynamic-cron",
  name: "Register Dynamic Cron",
  version: "0.1.1",
  enabled,
  trigger: customTrigger({
    name: "dynamic.cron",
    event: customEvent({
      payload: z.object({
        id: z.string(),
        cron: z.string(),
      }),
    }),
  }),
  run: async (payload, io, ctx) => {
    await io.registerCron("📆", dynamicSchedule, payload.id, {
      cron: payload.cron,
    });

    await io.wait("wait", 60);

    await io.unregisterCron("❌📆", dynamicSchedule, payload.id);
  },
});

new Job(client, {
  id: "use-dynamic-interval",
  name: "Use Dynamic Interval",
  version: "0.1.1",
  enabled,
  trigger: dynamicSchedule,
  run: async (payload, io, ctx) => {
    await io.wait("wait", 5); // wait for 5 seconds
    await io.logger.info("This is a log info message", {
      payload,
    });
    await io.sendCustomEvent("send-event", {
      name: "custom.event",
      payload,
      context: ctx,
    });
  },
});

new Job(client, {
  id: "scheduled-job-1",
  name: "Scheduled Job 1",
  version: "0.1.1",
  enabled: true,
  trigger: intervalTrigger({
    seconds: 60,
  }),
  run: async (payload, io, ctx) => {
    await io.wait("wait", 5); // wait for 5 seconds
    await io.logger.info("This is a log info message", {
      payload,
    });
    await io.sendCustomEvent("send-event", {
      name: "custom.event",
      payload,
      context: ctx,
    });
  },
});

new Job(client, {
  id: "scheduled-job-2",
  name: "Scheduled Job 2",
  version: "0.1.1",
  enabled,
  trigger: cronTrigger({
    cron: "*/5 * * * *", // every 5 minutes
  }),
  run: async (payload, io, ctx) => {
    await io.wait("wait", 5); // wait for 5 seconds
    await io.logger.info("This is a log info message", {
      payload,
      ctx,
    });
  },
});

new Job(client, {
  id: "test-io-functions",
  name: "Test IO functions",
  version: "0.1.1",
  enabled,
  trigger: customTrigger({
    name: "test.io",
    event: customEvent({
      payload: z.any(),
    }),
  }),
  run: async (payload, io, ctx) => {
    await io.wait("wait", 5); // wait for 5 seconds
    await io.logger.info("This is a log info message", {
      payload,
    });
    await io.sendCustomEvent("send-event", {
      name: "custom.event",
      payload,
      context: ctx,
    });
  },
});

new Job(client, {
  id: "register-dynamic-trigger-on-new-repo",
  name: "Register dynamic trigger on new repo",
  version: "0.1.1",
  enabled,
  trigger: customTrigger({
    name: "new.repo",
    event: customEvent({
      payload: z.object({ repo: z.string() }),
    }),
  }),
  run: async (payload, io, ctx) => {
    return await io.registerTrigger(
      "register-repo",
      dynamicOnIssueOpenedTrigger,
      payload.repo,
      {
        repo: payload.repo,
      }
    );
  },
});

new Job(client, {
  id: "listen-for-dynamic-trigger",
  name: "Listen for dynamic trigger",
  version: "0.1.1",
  enabled,
  trigger: dynamicOnIssueOpenedTrigger,
  integrations: {
    slack,
  },
  run: async (payload, io, ctx) => {
    await io.slack.postMessage("Slack 📝", {
      text: `New Issue opened on dynamically triggered repo: ${
        payload.issue.html_url
      }. \n\n${JSON.stringify(ctx)}`,
      channel: "C04GWUTDC3W",
    });
  },
});

new Job(client, {
  id: "listen-for-dynamic-trigger-2",
  name: "Listen for dynamic trigger-2",
  version: "0.1.1",
  enabled,
  trigger: dynamicOnIssueOpenedTrigger,
  integrations: {
    slack,
  },
  run: async (payload, io, ctx) => {
    await io.slack.postMessage("Slack 📝", {
      text: `New Issue opened on dynamically triggered repo 2: ${payload.issue.html_url}`,
      channel: "C04GWUTDC3W",
    });
  },
});

new Job(client, {
  id: "listen-for-dynamic-trigger-3",
  name: "Listen for dynamic trigger-3",
  version: "0.1.1",
  enabled,
  trigger: dynamicOnIssueOpenedTrigger,
  integrations: {
    slack,
  },
  run: async (payload, io, ctx) => {
    await io.slack.postMessage("Slack 📝", {
      text: `New Issue opened on dynamically triggered repo 3: ${payload.issue.html_url}`,
      channel: "C04GWUTDC3W",
    });
  },
});

new Job(client, {
  id: "alert-on-new-github-issues",
  name: "Alert on new GitHub issues",
  version: "0.1.1",
  enabled,
  integrations: {
    slack,
  },
  trigger: github.triggers.repo({
    event: events.onIssueOpened,
    repo: "ericallam/basic-starter-100k",
  }),
  run: async (payload, io, ctx) => {
    //todo logging isn't working
    // await io.logger.info("This is a simple log info message");
    const response = await io.slack.postMessage("Slack 📝", {
      text: `New Issue opened: ${payload.issue.html_url}`,
      channel: "C04GWUTDC3W",
    });
    // await io.logger.warn("You've been warned", response);
  },
});

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
