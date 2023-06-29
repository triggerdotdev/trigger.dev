import { github, slack } from "@/trigger";
import { events } from "@trigger.dev/github";
import { createAppRoute } from "@trigger.dev/nextjs";
import { Job, TriggerClient } from "@trigger.dev/sdk";

export const client = new TriggerClient({
  id: "nextjs-appdir-example",
  apiKey: process.env.TRIGGER_API_KEY,
  apiUrl: process.env.TRIGGER_API_URL,
  logLevel: "debug",
});

new Job(client, {
  id: "appdir-alert-on-new-github-issues",
  name: "AppDir: Alert on new GitHub issues",
  version: "0.1.1",
  enabled: true,
  integrations: {
    slack,
  },
  trigger: github.triggers.repo({
    event: events.onIssueOpened,
    owner: "ericallam",
    repo: "basic-starter-12k",
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

export const { POST, dynamic } = createAppRoute(client);
