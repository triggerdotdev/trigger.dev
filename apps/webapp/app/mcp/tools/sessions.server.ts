import { $replica } from "~/db.server";
import { S2RealtimeStreams } from "~/services/realtime/s2realtimeStreams.server";
import { SESSION_CHANNEL_NAME_REGEX } from "~/services/realtime/sessionChannels.server";
import {
  canonicalSessionAddressingKey,
  isSessionFriendlyIdForm,
  resolveSessionByIdOrExternalId,
  resolveSessionWithWriterFallback,
} from "~/services/realtime/sessions.server";
import { getRealtimeStreamInstance } from "~/services/realtime/v1StreamsGlobal.server";
import { fenceUntrusted } from "../gate/fence.server";
import type { McpToolDefinition } from "../registry.server";
import { defineReadTool, errorResult, textResult } from "./define.server";
import { subjectEnvironment } from "./query.server";
import { ReadSessionChannelInput } from "./schemas/sessions";

const POLL_INTERVAL_MS = 750;
const MAX_WAIT_SECONDS = 50;

export const sessionsTools: McpToolDefinition[] = [
  defineReadTool({
    name: "read_session_channel",
    title: "Read Session Channel",
    description:
      "Read records from a session's realtime stream: a named side channel (pass `channel`) or the reserved chat transcript pair (omit `channel`). By default returns whatever records exist after the optional cursor and closes (a point-in-time drain). Set `timeoutInSeconds` to wait for the next record when none exist yet. Read `out` for the producer's feed (e.g. a screencast) or `in` for what clients have sent. Use the returned nextCursor as `afterEventId` to page forward.",
    shape: ReadSessionChannelInput.shape,
    auth: { action: "read", subject: "sessions" },
    run: async (input, ctx) => {
      if (input.channel !== undefined && !SESSION_CHANNEL_NAME_REGEX.test(input.channel)) {
        return errorResult(
          `Invalid channel name "${input.channel}": use 1-128 chars from [A-Za-z0-9._-].`
        );
      }

      // Same rule as the realtime route: the reserved `.in` carries data for the agent only.
      if (input.channel === undefined && input.io === "in") {
        return errorResult("Reading the in channel requires secret key authentication");
      }

      if (input.afterEventId !== undefined && !/^\d+$/.test(input.afterEventId)) {
        return errorResult("afterEventId must be a numeric event id");
      }

      const environment = await subjectEnvironment(ctx);
      if (!environment) return errorResult("Environment not found");

      const row =
        input.channel === undefined
          ? await resolveSessionByIdOrExternalId($replica, environment.id, input.sessionId)
          : await resolveSessionWithWriterFallback(environment.id, input.sessionId);
      if (!row && isSessionFriendlyIdForm(input.sessionId)) {
        return errorResult("Session not found");
      }

      const stream = getRealtimeStreamInstance(environment, "v2", {
        session: row,
        organization: row ? null : environment.organization,
      });
      if (!(stream instanceof S2RealtimeStreams)) {
        return errorResult("Session channels require the S2 realtime backend");
      }

      const key = canonicalSessionAddressingKey(row, input.sessionId);
      const afterSeqNum = input.afterEventId !== undefined ? Number(input.afterEventId) : undefined;
      // One extra record tells us whether more are available.
      const drain = () =>
        stream.readSessionStreamRecords(
          key,
          input.io,
          afterSeqNum,
          input.channel,
          input.maxRecords + 1
        );

      let records = await drain();
      if (records.length === 0 && input.timeoutInSeconds !== undefined) {
        const deadline = Date.now() + Math.min(input.timeoutInSeconds, MAX_WAIT_SECONDS) * 1000;
        while (records.length === 0 && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
          records = await drain();
        }
      }

      const limited = records.slice(0, input.maxRecords);
      const hasMore = records.length > limited.length;
      const nextCursor = limited[limited.length - 1]?.seqNum;

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

      const body = lines.length > 0 ? [fenceUntrusted(lines.join("\n"), "session")] : [];
      return textResult([header, "", ...body].join("\n") + footer);
    },
  }),
];
