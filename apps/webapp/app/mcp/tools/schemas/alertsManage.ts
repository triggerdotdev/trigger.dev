import { z } from "zod";
import { CreateAlertInput } from "./alerts";
import { CommonProjectsInput } from "./common";

const Id = z.string().max(128);

const ChannelNotifiers = z
  .array(z.object({ type: z.literal("channel"), channelId: Id }))
  .min(1)
  .max(50)
  .describe(
    "Channels to notify, e.g. [{ type: 'channel', channelId: '<id>' }]. Pass the channelId from list_alert_channels, not the friendlyId."
  );

const Expiry = z
  .string()
  .max(64)
  .describe(
    'ISO 8601 timestamp in the future after which the alert stops, or "none" for no expiry.'
  );

export const AlertIdInput = CommonProjectsInput.extend({
  alertId: Id.describe("The id of the alert. Use list_alerts to find it."),
});
export type AlertIdInput = z.output<typeof AlertIdInput>;

export const UpdateAlertInput = AlertIdInput.extend({
  name: z.string().trim().min(1).max(120).describe("A new display name.").optional(),
  notifiers: ChannelNotifiers.describe("Replaces the alert's notifiers.").optional(),
  expiresAt: Expiry.optional(),
  compositeMode: z
    .enum(["any", "all"])
    .describe("For an alert group: raise when any member, or all members, need attention.")
    .optional(),
});
export type UpdateAlertInput = z.output<typeof UpdateAlertInput>;

export const ActivateAlertInput = AlertIdInput.extend({
  notifiers: ChannelNotifiers.describe("Replaces the alert's notifiers.").optional(),
  expiresAt: Expiry.optional(),
});
export type ActivateAlertInput = z.output<typeof ActivateAlertInput>;

const ScopeValue = z.string().max(512).optional();

const MemberCondition = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("threshold"),
    operator: z.enum([">", "<"]),
    value: z.number().finite(),
    windowSec: z.number().int().positive(),
    holdSec: z.number().int().positive().optional(),
  }),
  z.object({
    kind: z.literal("state"),
    stateKey: z.string().max(128),
    holdSec: z.number().int().positive().optional(),
    params: z
      .record(z.string().max(128), z.number())
      .refine((params) => Object.keys(params).length <= 20, "At most 20 params")
      .optional(),
  }),
  z.object({ kind: z.literal("occurrence") }),
  z.object({ kind: z.literal("absence"), quietWindowSec: z.number().int().min(1800) }),
]);

const MemberDraft = z
  .object({
    capabilityKey: z.string().max(128).describe(CreateAlertInput.shape.capabilityKey.description!),
    params: z.object({
      scope: z
        .object({
          type: z.enum(["queue", "queuePattern", "task", "all", "errorGroup"]),
          queue: ScopeValue,
          pattern: ScopeValue,
          taskIdentifier: ScopeValue,
          fingerprint: ScopeValue,
        })
        .optional()
        .describe("Defaults to all."),
      windowSec: z.number().optional(),
    }),
    condition: MemberCondition,
    behavior: z.object({ expiresAt: z.string().max(64).optional() }).optional(),
    notifiers: ChannelNotifiers,
    name: z.string().max(120).optional(),
    query: CreateAlertInput.shape.query,
    signal: z
      .object({
        mode: z.enum(["threshold", "absence", "match"]),
        measure: z.string().max(128).optional(),
      })
      .optional(),
  })
  .strict();

export const CreateAlertGroupInput = CommonProjectsInput.extend({
  name: z.string().trim().min(1).max(120).describe("The group's display name."),
  compositeMode: z
    .enum(["any", "all"])
    .default("any")
    .describe("Raise when any member, or all members, need attention."),
  notifiers: ChannelNotifiers,
  expiresAt: z
    .string()
    .datetime()
    .max(64)
    .describe("Optional ISO 8601 expiry for the group.")
    .optional(),
  memberAlertIds: z
    .array(Id)
    .max(20)
    .describe("Existing active alerts to group. Pass this or members, not both.")
    .optional(),
  members: z
    .array(MemberDraft)
    .min(2)
    .max(20)
    .describe(
      "New alerts to create and group, each shaped like create_alert. Pass this or memberAlertIds, not both."
    )
    .optional(),
});
export type CreateAlertGroupInput = z.output<typeof CreateAlertGroupInput>;
