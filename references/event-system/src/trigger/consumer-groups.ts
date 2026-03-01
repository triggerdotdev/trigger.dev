import { task, logger } from "@trigger.dev/sdk";
import { userActivity } from "./events";

// ---- Consumer Groups: Load-balanced event handling ----
// Within a consumer group, only ONE task receives each event.

export const activityProcessorA = task({
  id: "activity-processor-a",
  on: userActivity,
  consumerGroup: "activity-processors",
  run: async (payload) => {
    logger.info("Processor A handling activity", {
      userId: payload.userId,
      action: payload.action,
    });
    return { processor: "A", userId: payload.userId };
  },
});

export const activityProcessorB = task({
  id: "activity-processor-b",
  on: userActivity,
  consumerGroup: "activity-processors",
  run: async (payload) => {
    logger.info("Processor B handling activity", {
      userId: payload.userId,
      action: payload.action,
    });
    return { processor: "B", userId: payload.userId };
  },
});

// This task is NOT in the consumer group — it receives ALL events
export const activityAnalytics = task({
  id: "activity-analytics",
  on: userActivity,
  run: async (payload) => {
    logger.info("Analytics: recording activity", {
      userId: payload.userId,
      action: payload.action,
    });
    return { recorded: true };
  },
});
