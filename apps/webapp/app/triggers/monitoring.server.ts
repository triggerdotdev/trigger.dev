import { Trigger, scheduleEvent } from "@trigger.dev/sdk";
import { slack } from "@trigger.dev/integrations";
import { prisma } from "~/db.server";

export const uptimeCheck = new Trigger({
  id: "uptime-check",
  name: "Uptime Check",
  on: scheduleEvent({ rateOf: { minutes: 5 } }),
  logLevel: "info",
  triggerTTL: 60,
  run: async (event, context) => {
    if (context.environment === "development" && !context.isTest) {
      return;
    }

    const filterCondition = {
      where: { createdAt: { gte: event.lastRunAt, lt: event.scheduledTime } },
    };

    // Grab counts of workflows, runs, and steps
    const userCount = await prisma.user.count(filterCondition);
    const workflowCount = await prisma.workflow.count(filterCondition);
    const runCount = await prisma.workflowRun.count(filterCondition);
    const stepCount = await prisma.workflowRunStep.count(filterCondition);

    await slack.postMessage("Uptime Notification", {
      channelName: "monitoring",
      text: `[${
        context.environment
      }][${event.scheduledTime.toLocaleString()}] Uptime Check: ${userCount} new users, ${workflowCount} new workflows, ${runCount} new runs, ${stepCount} new steps.`,
    });
  },
});
