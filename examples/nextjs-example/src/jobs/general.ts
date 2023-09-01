import { client, github, githubUser, openai, slack } from "@/trigger";
import { events } from "@trigger.dev/github";
import {
  Job,
  cronTrigger,
  eventTrigger,
  intervalTrigger,
  isTriggerError,
  missingConnectionNotification,
  missingConnectionResolvedNotification,
} from "@trigger.dev/sdk";
import { z } from "zod";

const enabled = true;

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
