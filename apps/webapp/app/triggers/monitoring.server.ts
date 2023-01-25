import { Trigger, scheduleEvent } from "@trigger.dev/sdk";
import { slack } from "@trigger.dev/integrations";
import { prisma } from "~/db.server";

export const uptimeCheck = new Trigger({
  id: "uptime-check",
  name: "Uptime Check",
  on: scheduleEvent({ rateOf: { minutes: 1 } }),
  triggerTTL: 300,
  run: async (event, context) => {
    // Grab counts of workflows, runs, and steps
    const userCount = await prisma.user.count();
    const workflowCount = await prisma.workflow.count();
    const runCount = await prisma.workflowRun.count();
    const stepCount = await prisma.workflowRunStep.count();

    if (context.environment === "development") {
      return;
    }

    await slack.postMessage("Uptime Notification", {
      channelName: "monitoring",
      text: `[${context.environment}] Uptime Check: ${userCount} users, ${workflowCount} workflows, ${runCount} runs, ${stepCount} steps.`,
    });
  },
});
