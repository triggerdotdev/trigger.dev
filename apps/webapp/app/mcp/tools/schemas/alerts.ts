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

export const ListAlertChannelsInput = CommonProjectsInput;

export const GetAlertDetailsInput = CommonProjectsInput.extend({
  alertId: z.string().describe("The id of the alert. Use list_alerts to find it."),
});

const AlertScope = z.object({
  type: z.enum(["queue", "queuePattern", "task", "all", "errorGroup"]),
  queue: z.string().optional(),
  pattern: z.string().optional(),
  taskIdentifier: z.string().optional(),
  fingerprint: z.string().optional(),
});

const AlertCondition = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("threshold"),
    operator: z.enum([">", "<"]),
    value: z.number().finite(),
    windowSec: z.number().int().positive(),
    holdSec: z.number().int().positive().optional(),
  }),
  z.object({
    kind: z.literal("state"),
    stateKey: z.string(),
    holdSec: z.number().int().positive().optional(),
    params: z
      .record(z.string(), z.number())
      .optional()
      .describe("Overrides for the capability's param defaults, e.g. thresholds."),
  }),
  z.object({ kind: z.literal("occurrence") }),
  z.object({ kind: z.literal("absence"), quietWindowSec: z.number().int().min(1800) }),
]);

const AlertNotifier = z.discriminatedUnion("type", [
  z.object({ type: z.literal("channel"), channelId: z.string() }),
  z.object({
    type: z.literal("chat"),
    chatId: z.string(),
    userId: z.string().optional(),
  }),
]);

export const CreateAlertInput = CommonProjectsInput.extend({
  capabilityKey: z
    .string()
    .describe(
      "The capability key to monitor. Use list_alert_capabilities to discover available keys."
    ),
  params: z
    .object({
      scope: AlertScope.optional().describe("Defaults to all."),
      windowSec: z.number().optional(),
    })
    .describe(
      "The scope for this capability, e.g. { scope: { type: 'queue', queue: 'my-queue' } } or { scope: { type: 'errorGroup', taskIdentifier, fingerprint } }."
    ),
  condition: AlertCondition.describe(
    "The condition that raises the alert, matching the kind returned by list_alert_capabilities for this capability."
  ),
  behavior: z
    .object({
      expiresAt: z.string().describe("ISO 8601 timestamp after which the alert stops.").optional(),
    })
    .describe("Optional expiry. Alerts keep firing until they expire or are stopped."),
  notifiers: z
    .array(AlertNotifier)
    .min(1)
    .describe("Who to notify when the alert raises, e.g. [{ type: 'chat', chatId: '<id>' }]."),
  name: z.string().describe("An optional display name for the alert.").optional(),
  query: z
    .string()
    .max(8192)
    .describe("The TRQL query a custom.query alert watches. Only valid with custom.query.")
    .optional(),
  signal: z
    .object({
      mode: z.enum(["threshold", "absence", "match"]),
      measure: z.string().max(128).optional(),
    })
    .describe(
      "How a custom.query alert reads its query: threshold on a measure, absence of rows, or any matching row. Only valid with custom.query."
    )
    .optional(),
});
