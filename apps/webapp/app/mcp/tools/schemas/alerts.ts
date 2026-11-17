import { z } from "zod";
import { CommonProjectsInput } from "./common";

export const ListAlertCapabilitiesInput = CommonProjectsInput.omit({
  environment: true,
  branch: true,
}).extend({
  area: z
    .string()
    .describe("Filter capabilities to a specific area, e.g. 'queues', 'runs', 'health'.")
    .optional(),
});

export const ListAlertsInput = CommonProjectsInput.extend({
  lifecycle: z
    .enum(["active", "completed", "expired", "stopped"])
    .describe("Filter by alert lifecycle state.")
    .optional(),
  attention: z
    .enum(["clear", "needs_attention"])
    .describe("Filter by whether the alert currently needs attention.")
    .optional(),
});
