import { Trigger, scheduleEvent, customEvent } from "@trigger.dev/sdk";
import { slack } from "@trigger.dev/integrations";
import { getTableCount } from "./db";
import { z } from "zod";

export const uptimeCheck = new Trigger({
  id: "uptime-check",
  name: "Uptime Check",
  on: scheduleEvent({ rateOf: { minutes: 5 } }),
  logLevel: "debug",
  triggerTTL: 300,
  endpoint: process.env.TRIGGER_WSS_URL,
  run: async (event, context) => {
    if (context.environment === "development" && !context.isTest) {
      return;
    }

    const { lastRunAt, scheduledTime } = event;

    if (!lastRunAt) {
      return;
    }

    // Grab counts of workflows, runs, and steps
    const userCount = await getTableCount("User", lastRunAt, scheduledTime);
    const workflowCount = await getTableCount(
      "Workflow",
      lastRunAt,
      scheduledTime
    );
    const runCount = await getTableCount(
      "WorkflowRun",
      lastRunAt,
      scheduledTime
    );
    const stepCount = await getTableCount(
      "WorkflowRunStep",
      lastRunAt,
      scheduledTime
    );

    await slack.postMessage("Uptime Notification", {
      channelName: "monitoring",
      text: `[${
        context.environment
      }][${event.scheduledTime.toLocaleString()}] Uptime Check: ${userCount} new users, ${workflowCount} new workflows, ${runCount} new runs, ${stepCount} new steps`,
    });
  },
});

export const healthCheck = new Trigger({
  id: "health-check",
  name: "Health Check",
  endpoint: process.env.TRIGGER_WSS_URL,
  logLevel: "debug",
  triggerTTL: 600,
  on: customEvent({
    name: "health.check",
    schema: z.object({
      url: z.string().url(),
      host: z.string(),
    }),
  }),
  run: async (event, context) => {
    const response = await context.fetch("fetch site", event.url, {
      method: "GET",
      retry: {
        enabled: false,
      },
    });

    if (response.ok) {
      await context.logger.info(`${event.host} is up!`);
      return;
    }

    await slack.postMessage("Site is down", {
      channelName: "health-checks",
      text: `${event.host} is down: ${response.status}`,
    });
  },
});

export const checkScheduler = new Trigger({
  id: "check-scheduler",
  name: "Check Scheduler",
  on: scheduleEvent({ rateOf: { minutes: 10 } }),
  logLevel: "info",
  triggerTTL: 600,
  endpoint: process.env.TRIGGER_WSS_URL,
  run: async (event, context) => {
    if (context.environment === "development" && !context.isTest) {
      return;
    }

    await context.sendEvent("health.check trigger.dev", {
      name: "health.check",
      payload: {
        url: "https://trigger.dev",
        host: "trigger.dev",
      },
    });

    await context.sendEvent("health.check docs.trigger.dev", {
      name: "health.check",
      payload: {
        url: "https://docs.trigger.dev",
        host: "docs.trigger.dev",
      },
    });

    await context.sendEvent("health.check app.trigger.dev", {
      name: "health.check",
      payload: {
        url: "https://app.trigger.dev/healthcheck",
        host: "app.trigger.dev",
      },
    });
  },
});
