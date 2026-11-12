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
