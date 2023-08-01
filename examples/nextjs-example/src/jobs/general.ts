import { client, github, githubUser, openai, slack } from "@/trigger";
import { events } from "@trigger.dev/github";
import {
  DynamicSchedule,
  DynamicTrigger,
  Job,
  cronTrigger,
  eventTrigger,
  intervalTrigger,
  isTriggerError,
  missingConnectionNotification,
  missingConnectionResolvedNotification,
} from "@trigger.dev/sdk";
import { z } from "zod";

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

client.defineJob({
  id: "test-background-fetch-retry",
  name: "Test background fetch retry",
  version: "0.0.1",
  enabled,
  trigger: eventTrigger({
    name: "test.background-fetch",
    schema: z.object({
      url: z.string(),
      method: z.string().optional(),
      headers: z.record(z.string()).optional(),
      body: z.any().optional(),
      retry: z.any().optional(),
    }),
  }),
  run: async (payload, io, ctx) => {
    return await io.backgroundFetch<any>(
      "fetch",
      payload.url,
      {
        method: payload.method ?? "GET",
        headers: payload.headers,
        body: payload.body ? JSON.stringify(payload.body) : undefined,
      },
      payload.retry
    );
  },
});

const CHAT_MODELS = [
  "gpt-3.5-turbo",
  "gpt-3.5-turbo-0301",
  "gpt-3.5-turbo-0613",
  "gpt-3.5-turbo-16k",
  "gpt-3.5-turbo-16k-0613",
  "gpt-4",
  "gpt-4-0314",
  "gpt-4-0613",
];

client.defineJob({
  id: "openai-test",
  name: "OpenAI Test",
  version: "0.0.1",
  enabled,
  trigger: eventTrigger({
    name: "openai.test",
    schema: z.object({
      model: z.string(),
      prompt: z.string(),
      background: z.boolean().optional(),
    }),
  }),
  integrations: {
    openai,
  },
  run: async (payload, io, ctx) => {
    if (CHAT_MODELS.includes(payload.model)) {
      if (payload.background) {
        const completion = await io.openai.backgroundCreateChatCompletion("✨", {
          model: payload.model,
          messages: [
            {
              role: "user",
              content: payload.prompt,
            },
          ],
        });

        return completion;
      }

      const completion = await io.openai.createChatCompletion("✨", {
        model: payload.model,
        messages: [
          {
            role: "user",
            content: payload.prompt,
          },
        ],
      });

      return completion;
    }

    if (payload.background) {
      const completion = await io.openai.backgroundCreateCompletion("✨", {
        model: payload.model,
        prompt: payload.prompt,
      });

      return completion;
    }

    const completion = await io.openai.createCompletion("✨", {
      model: payload.model,
      prompt: payload.prompt,
    });

    return completion;
  },
});

client.defineJob({
  id: "openai-errors",
  name: "OpenAI Errors",
  version: "0.0.1",
  enabled,
  trigger: eventTrigger({
    name: "openai.errors",
  }),
  integrations: {
    openai,
  },
  run: async (payload, io, ctx) => {
    await io.openai.createChatCompletion("chat-completion", {
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "system",
          content: "You are an AI assistant that is helpful, creative, clever, and very friendly.",
        },
        {
          role: "user",
          content: "Call the supplied function that will tweet a really funny joke",
        },
      ],
      function_call: { name: "tweetFunnyJoke" },
      functions: [
        {
          name: "tweetFunnyJoke",
          description:
            "Tweets a really funny joke. The joke is so funny that it will make you laugh out loud.",
          parameters: {
            type: "array",
            items: {
              type: "string",
            },
          },
        },
      ],
    });
  },
});

client.defineJob({
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

client.defineJob({
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
          text: `Missing developer connection resolved: ${JSON.stringify(payload)}`,
          channel: "C04GWUTDC3W",
        });
      }
      case "EXTERNAL": {
        return await io.slack.postMessage("message", {
          text: `Missing external connection resolved: ${JSON.stringify(payload)}`,
          channel: "C04GWUTDC3W",
        });
      }
    }
  },
});

client.defineJob({
  id: "user-on-issue-opened",
  name: "user on issue opened",
  version: "0.1.1",
  enabled,
  trigger: dynamicUserTrigger,
  integrations: {
    github: githubUser,
  },
  run: async (payload, io, ctx) => {
    await io.logger.info("user-on-issue-opened", { ctx });

    return await io.github.getRepo("get.repo", {
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
    });
  },
});

client.defineJob({
  id: "get-user-repo",
  name: "Get User Repo",
  version: "0.1.1",
  enabled,
  trigger: eventTrigger({
    name: "get.repo",
    schema: z.object({
      owner: z.string(),
      repo: z.string(),
    }),
  }),
  integrations: {
    github: githubUser,
  },
  run: async (payload, io, ctx) => {
    return await io.github.getRepo("get.repo", payload);
  },
});

client.defineJob({
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
      owner: ctx.event.context.source.metadata.owner,
      repo: ctx.event.context.source.metadata.repo,
    });
  },
});

client.defineJob({
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

client.defineJob({
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

client.defineJob({
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

client.defineJob({
  id: "event-1",
  name: "Run when the foo.bar event happens",
  version: "0.0.1",
  enabled: true,
  trigger: eventTrigger({
    name: "foo.bar",
  }),
  run: async (payload, io, ctx) => {
    await io.try(
      async () => {
        return await io.runTask("task-1", { name: "task-1", retry: { limit: 3 } }, async (task) => {
          if (task.attempts > 2) {
            return {
              bar: "foo",
            };
          }

          throw new Error(`Task failed on ${task.attempts} attempt(s)`);
        });
      },
      async (error) => {
        // These should never be reached
        await io.wait("wait-after-error", 5);

        await io.logger.error("This is a log error message", {
          payload,
          error,
        });

        return {
          foo: "bar",
        };
      }
    );

    try {
      await io.runTask("task-2", { name: "task-2", retry: { limit: 5 } }, async (task) => {
        throw new Error(`Task failed on ${task.attempts} attempt(s)`);
      });
    } catch (error) {
      if (isTriggerError(error)) {
        throw error;
      }

      await io.wait("wait-after-error", 5);

      await io.logger.error("This is a log error message", {
        payload,
        error,
      });
    }

    return {
      payload,
    };
  },
});

client.defineJob({
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

    await io.wait("5 minutes", 5 * 60);

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

client.defineJob({
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

    return {
      message: "Hello from scheduled job 1",
    };
  },
});

client.defineJob({
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

client.defineJob({
  id: "register-dynamic-trigger-on-new-repo",
  name: "Register dynamic trigger on new repo",
  version: "0.1.1",
  enabled,
  trigger: eventTrigger({
    name: "new.repo",
    schema: z.object({ owner: z.string(), repo: z.string() }),
  }),
  run: async (payload, io, ctx) => {
    return await io.registerTrigger("register-repo", dynamicOnIssueOpenedTrigger, payload.repo, {
      owner: payload.owner,
      repo: payload.repo,
    });
  },
});

client.defineJob({
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

client.defineJob({
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

client.defineJob({
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

client.defineJob({
  id: "alert-on-new-github-issues-3",
  name: "Alert on new GitHub issues",
  version: "0.1.1",
  enabled,
  integrations: {
    slack,
  },
  trigger: github.triggers.repo({
    event: events.onIssueOpened,
    owner: "ericallam",
    repo: "basic-starter-12k",
  }),
  run: async (payload, io, ctx) => {
    await io.runTask("slow task", { name: "slow task" }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    });

    await io.logger.info("This is a simple log info message");

    await io.wait("wait", 5); // wait for 5 seconds

    const response = await io.slack.postMessage("Slack 📝", {
      text: `New Issue opened: ${payload.issue.html_url}`,
      channel: "C04GWUTDC3W",
    });

    return response;
  },
});
