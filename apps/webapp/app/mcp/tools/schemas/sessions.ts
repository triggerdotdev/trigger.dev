import { z } from "zod";
import { CommonProjectsInput } from "./common";

export const ReadSessionChannelInput = CommonProjectsInput.extend({
  sessionId: z
    .string()
    .describe("The session id (session_* friendlyId) or the externalId it was created with."),
  channel: z
    .string()
    .describe(
      "The named side channel to read. Omit to read the session's reserved chat transcript pair."
    )
    .optional(),
  io: z
    .enum(["out", "in"])
    .describe("Which side to read: `out` (producer feed) or `in` (client input).")
    .default("out"),
  afterEventId: z
    .string()
    .describe(
      "Cursor: only return records after this event id. Use the nextCursor from a prior read."
    )
    .optional(),
  maxRecords: z
    .number()
    .int()
    .positive()
    .max(500)
    .describe("Maximum records to return (default 100).")
    .default(100),
  timeoutInSeconds: z
    .number()
    .int()
    .positive()
    .max(60)
    .describe(
      "Wait up to this many seconds for at least one record when none exist yet (a bounded tail). Omit for an immediate point-in-time read."
    )
    .optional(),
});

export const WriteSessionChannelInput = CommonProjectsInput.extend({
  sessionId: z
    .string()
    .describe("The session id (session_* friendlyId) or the externalId it was created with."),
  channel: z.string().describe("The named side channel to write to."),
  value: z
    .union([z.string(), z.record(z.string(), z.unknown())])
    .describe(
      "The record to append to the channel's `in` stream. Pass an object for a structured record (e.g. { paused: true }) or a string for a raw record."
    ),
});

const SessionIdInput = z
  .string()
  .min(1)
  .max(256)
  .describe("The session id (session_* friendlyId) or the externalId it was created with.");

const filterList = (description: string) =>
  z.array(z.string().min(1).max(256)).max(20).describe(description).optional();

export const ListSessionsInput = CommonProjectsInput.extend({
  statuses: z
    .array(z.enum(["ACTIVE", "CLOSED", "EXPIRED"]))
    .max(3)
    .describe("Only sessions with these statuses.")
    .optional(),
  types: filterList("Only sessions of these types, e.g. chat.agent."),
  taskIdentifiers: filterList("Only sessions of these agents (their task ids)."),
  externalId: z
    .string()
    .min(1)
    .max(256)
    .describe("Only the session with this externalId.")
    .optional(),
  tags: filterList("Only sessions with any of these tags."),
  period: z
    .string()
    .regex(/^\d{1,4}[mhdw]$/)
    .describe('Only sessions created in this last period, e.g. "1h", "7d" or "30d".')
    .optional(),
  from: z
    .string()
    .datetime()
    .describe("Only sessions created at or after this ISO 8601 time. Ignored when period is set.")
    .optional(),
  to: z
    .string()
    .datetime()
    .describe("Only sessions created at or before this ISO 8601 time. Ignored when period is set.")
    .optional(),
  cursor: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,128}$/)
    .describe("The cursor from a previous call.")
    .optional(),
  direction: z
    .enum(["forward", "backward"])
    .describe("`forward` (default) pages to older sessions, `backward` to newer ones.")
    .optional(),
  limit: z.number().int().min(1).max(50).describe("How many to return (default 25).").optional(),
});

export const SessionDetailsInput = CommonProjectsInput.extend({
  sessionId: SessionIdInput,
});

export const ReadSessionTranscriptInput = CommonProjectsInput.extend({
  sessionId: SessionIdInput,
  before: z
    .string()
    .min(1)
    .max(256)
    .describe(
      "Cursor: return the messages before this message id. Use the cursor from a prior read."
    )
    .optional(),
  maxMessages: z
    .number()
    .int()
    .min(1)
    .max(100)
    .describe("Maximum messages to return. Up to 100, defaults to 20.")
    .default(20),
});

export const UpdateSessionInput = CommonProjectsInput.extend({
  sessionId: SessionIdInput,
  tags: z
    .array(z.string().max(128))
    .max(10)
    .describe("Replaces all of the session's tags. Up to 10, each up to 128 characters.")
    .optional(),
  metadata: z
    .record(z.string(), z.unknown())
    .nullable()
    .describe("Replaces the session's metadata in full. Pass null to clear it.")
    .optional(),
});

export type UpdateSessionInput = z.output<typeof UpdateSessionInput>;

export const CloseSessionInput = CommonProjectsInput.extend({
  sessionId: SessionIdInput,
  reason: z.string().max(256).describe("Why the session is closed, stored with it.").optional(),
});

export type CloseSessionInput = z.output<typeof CloseSessionInput>;

export const ListPlaygroundConversationsInput = CommonProjectsInput.extend({
  agentSlug: z
    .string()
    .min(1)
    .max(256)
    .describe("The agent's task id. Use list_agents to find it."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(10)
    .describe("How many to return, up to 10 (default 10).")
    .optional(),
});

export const DeletePlaygroundConversationInput = CommonProjectsInput.extend({
  chatId: z
    .string()
    .min(1)
    .max(256)
    .describe("The conversation's chat id. Use list_playground_conversations to find it."),
});

export type DeletePlaygroundConversationInput = z.output<typeof DeletePlaygroundConversationInput>;
