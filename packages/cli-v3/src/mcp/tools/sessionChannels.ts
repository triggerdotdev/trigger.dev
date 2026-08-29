import { z } from "zod";
import { toolsMetadata } from "../config.js";
import { CommonProjectsInput } from "../schemas.js";
import { respondWithError, toolHandler } from "../utils.js";

const SESSION_CHANNEL_NAME_REGEX = /^[A-Za-z0-9._-]{1,128}$/;

const ReadSessionChannelInput = CommonProjectsInput.extend({
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
});

export const readSessionChannelTool = {
  name: toolsMetadata.read_session_channel.name,
  title: toolsMetadata.read_session_channel.title,
  description: toolsMetadata.read_session_channel.description,
  inputSchema: ReadSessionChannelInput.shape,
  handler: toolHandler(ReadSessionChannelInput.shape, async (input, { ctx }) => {
    ctx.logger?.log("calling read_session_channel", { input });

    if (ctx.options.devOnly && input.environment !== "dev") {
      return respondWithError(`This MCP server is only available for the dev environment.`);
    }

    if (input.channel !== undefined && !SESSION_CHANNEL_NAME_REGEX.test(input.channel)) {
      return respondWithError(
        `Invalid channel name "${input.channel}": use 1-128 chars from [A-Za-z0-9._-].`
      );
    }

    const projectRef = await ctx.getProjectRef({
      projectRef: input.projectRef,
      cwd: input.configPath,
    });

    const apiClient = await ctx.getApiClient({
      projectRef,
      environment: input.environment,
      scopes: ["read:sessions"],
      branch: input.branch,
    });

    const { records } = await apiClient.readSessionStreamRecords(input.sessionId, input.io, {
      channel: input.channel,
      afterEventId: input.afterEventId,
    });

    const limited = records.slice(0, input.maxRecords);
    const hasMore = records.length > limited.length;
    const nextCursor = limited.at(-1)?.seqNum;

    const label = input.channel ? `channel "${input.channel}"` : "reserved pair";
    const header = `Session ${input.sessionId} ${label} .${input.io}: ${limited.length} record${
      limited.length === 1 ? "" : "s"
    }${hasMore ? ` (more available)` : ""}`;

    const lines = limited.map((record) => {
      const data = typeof record.data === "string" ? record.data : JSON.stringify(record.data);
      return `#${record.seqNum} ${data}`;
    });

    const footer =
      nextCursor !== undefined && hasMore
        ? `\n\nMore records available. Read again with afterEventId "${nextCursor}" to continue.`
        : "";

    return {
      content: [
        {
          type: "text",
          text: [header, "", ...lines].join("\n") + footer,
        },
      ],
    };
  }),
};

const WriteSessionChannelInput = CommonProjectsInput.extend({
  sessionId: z
    .string()
    .describe("The session id (session_* friendlyId) or the externalId it was created with."),
  channel: z.string().describe("The named side channel to write to."),
  value: z
    .string()
    .describe(
      "The record to append to the channel's `in` stream. Pass a JSON string for structured records (e.g. '{\"paused\":true}')."
    ),
});

export const writeSessionChannelTool = {
  name: toolsMetadata.write_session_channel.name,
  title: toolsMetadata.write_session_channel.title,
  description: toolsMetadata.write_session_channel.description,
  inputSchema: WriteSessionChannelInput.shape,
  handler: toolHandler(WriteSessionChannelInput.shape, async (input, { ctx }) => {
    ctx.logger?.log("calling write_session_channel", { input });

    if (ctx.options.devOnly && input.environment !== "dev") {
      return respondWithError(`This MCP server is only available for the dev environment.`);
    }

    if (!SESSION_CHANNEL_NAME_REGEX.test(input.channel)) {
      return respondWithError(
        `Invalid channel name "${input.channel}": use 1-128 chars from [A-Za-z0-9._-].`
      );
    }

    const projectRef = await ctx.getProjectRef({
      projectRef: input.projectRef,
      cwd: input.configPath,
    });

    const apiClient = await ctx.getApiClient({
      projectRef,
      environment: input.environment,
      scopes: ["write:sessions"],
      branch: input.branch,
    });

    await apiClient.appendToSessionStream(
      input.sessionId,
      "in",
      input.value,
      undefined,
      input.channel
    );

    return {
      content: [
        {
          type: "text",
          text: `Wrote 1 record to session ${input.sessionId} channel "${input.channel}" .in. This does not wake or trigger a run.`,
        },
      ],
    };
  }),
};
