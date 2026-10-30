import { Trigger } from "@trigger.dev/convex";
import { components, internal } from "./_generated/api";

export const trigger: Trigger = new Trigger(components.trigger, {
  baseUrl: process.env.TRIGGER_API_URL,
  onComplete: internal.jobs.complete,
});
