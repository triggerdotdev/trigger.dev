import { Github, events } from "@trigger.dev/github";
import {
  DynamicSchedule,
  DynamicTrigger,
  Job,
  TriggerClient,
  cronTrigger,
  eventTrigger,
  intervalTrigger,
  missingConnectionNotification,
  missingConnectionResolvedNotification,
} from "@trigger.dev/sdk";
import { Slack } from "@trigger.dev/slack";
import { z } from "zod";

export const client = new TriggerClient({
  id: "nextjs-example",
  url: process.env.VERCEL_URL,
  apiKey: process.env.TRIGGER_API_KEY,
  apiUrl: process.env.TRIGGER_API_URL,
  logLevel: "debug",
});

export const github = new Github({ id: "github" });
const githubUser = new Github({ id: "github-user" });

// const githubLocal = new Github({
//   id: "github-local",
//   token: process.env.GITHUB_TOKEN,
// });

export const slack = new Slack({ id: "my-slack-new" });

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
  trigger: eventTrigger({
    name: "get.repo",
    schema: z.object({
      repo: z.string(),
    }),
  }),
  integrations: {
    github: githubUser,
  },
  run: async (payload, io, ctx) => {
    await io.logger.info("This is a log info message", {
      payload,
    });

    await io.wait("wait", 1);

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
  trigger: eventTrigger({
    name: "dynamic.interval",
    schema: z.object({
      id: z.string(),
      seconds: z.number().int().positive(),
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
  trigger: eventTrigger({
    name: "dynamic.cron",
    schema: z.object({
      id: z.string(),
      cron: z.string(),
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
    await io.sendEvent("send-event", {
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
    await io.sendEvent("send-event", {
      name: "custom.event",
      payload,
      context: ctx,
    });

    await io.runTask(
      "level 1",
      {
        name: "Level 1",
      },
      async () => {
        await io.runTask(
          "level 2",
          {
            name: "Level 2",
          },
          async () => {
            await io.runTask(
              "level 3",
              {
                name: "Level 3",
              },
              async () => {
                await io.runTask(
                  "level 4",
                  {
                    name: "Level 4",
                  },
                  async () => {
                    await io.runTask(
                      "level 5",
                      {
                        name: "Level 5",
                      },
                      async () => {}
                    );
                  }
                );
              }
            );
          }
        );
      }
    );

    await io.runTask(
      "Fingers crossed",
      {
        name: "Just a task 🤞",
      },
      async () => {
        throw new Error("You messed up buddy!");
      }
    );
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
  trigger: eventTrigger({
    name: "test.io",
  }),
  run: async (payload, io, ctx) => {
    await io.wait("wait", 5); // wait for 5 seconds
    await io.logger.info("This is a log info message", {
      payload,
    });
    await io.sendEvent("send-event", {
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
  trigger: eventTrigger({
    name: "new.repo",
    schema: z.object({ repo: z.string() }),
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
  id: "alert-on-new-github-issues-3",
  name: "Alert on new GitHub issues",
  version: "0.1.1",
  enabled,
  integrations: {
    slack,
  },
  trigger: github.triggers.repo({
    event: events.onIssueOpened,
    repo: "ericallam/basic-starter-12k",
  }),
  run: async (payload, io, ctx) => {
    await io.wait("wait", 5); // wait for 5 seconds

    await io.logger.info("This is a simple log info message");

    const response = await io.slack.postMessage("Slack 📝", {
      text: `New Issue opened: ${payload.issue.html_url}`,
      channel: "C04GWUTDC3W",
    });

    return response;
  },
});
