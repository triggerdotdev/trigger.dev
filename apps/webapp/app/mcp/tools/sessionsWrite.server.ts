import { tryCatch } from "@trigger.dev/core/utils";
import type { Session } from "@trigger.dev/database";
import { nanoid } from "nanoid";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { S2RealtimeStreams } from "~/services/realtime/s2realtimeStreams.server";
import { SESSION_CHANNEL_NAME_REGEX } from "~/services/realtime/sessionChannels.server";
import {
  canonicalSessionAddressingKey,
  resolveSessionWithWriterFallback,
} from "~/services/realtime/sessions.server";
import { getRealtimeStreamInstance } from "~/services/realtime/v1StreamsGlobal.server";
import { ServiceValidationError } from "~/v3/services/common.server";
import type { McpToolDefinition } from "../registry.server";
import { errorResult, resolveToolEnvironment, textResult } from "./define.server";
import { defineWriteTool } from "./defineWrite.server";
import { WriteSessionChannelInput } from "./schemas/sessions";

type AppendChannelRecord = (
  environment: AuthenticatedEnvironment,
  session: Session,
  record: { addressingKey: string; channel: string; body: string }
) => Promise<{ ok: true } | { ok: false; error: string }>;

const appendChannelRecord: AppendChannelRecord = async (environment, session, record) => {
  const stream = getRealtimeStreamInstance(environment, "v2", { session });
  if (!(stream instanceof S2RealtimeStreams)) {
    return { ok: false, error: "Session channels require the S2 realtime backend" };
  }

  const [appendError] = await tryCatch(
    stream.appendPartToSessionStream(
      record.body,
      nanoid(7),
      record.addressingKey,
      "in",
      record.channel
    )
  );
  if (appendError instanceof ServiceValidationError) {
    return { ok: false, error: appendError.message };
  }
  if (appendError) throw appendError;
  return { ok: true };
};

export function createSessionsWriteTools(
  options: { append?: AppendChannelRecord } = {}
): McpToolDefinition[] {
  const append = options.append ?? appendChannelRecord;

  return [
    defineWriteTool({
      name: "write_session_channel",
      title: "Write Session Channel",
      description:
        "Append one record to a named side channel's `in` stream on a session. Use this to send control input to a running agent (e.g. a pause/viewport command) without waking or triggering a run. Requires a `channel` name; the reserved transcript and the `out` side are not writable here (`out` is producer-only). Pass `value` as an object for a structured record or a string for a raw one.",
      shape: WriteSessionChannelInput.shape,
      approval: "configurable",
      auth: { action: "write", subject: "sessions" },
      run: async (input, ctx) => {
        if (!SESSION_CHANNEL_NAME_REGEX.test(input.channel)) {
          return errorResult(
            `Invalid channel name "${input.channel}": use 1-128 chars from [A-Za-z0-9._-].`
          );
        }

        const environment = await resolveToolEnvironment(ctx);
        if (!environment) return errorResult("Environment not found");

        const session = await resolveSessionWithWriterFallback(environment.id, input.sessionId);
        if (!session) return errorResult("Session not found");
        if (session.closedAt) return errorResult("Cannot append to a closed session");
        if (session.expiresAt && session.expiresAt.getTime() < Date.now()) {
          return errorResult("Cannot append to an expired session");
        }

        const appended = await append(environment, session, {
          addressingKey: canonicalSessionAddressingKey(session, input.sessionId),
          channel: input.channel,
          body: typeof input.value === "string" ? input.value : JSON.stringify(input.value),
        });
        if (!appended.ok) return errorResult(appended.error);

        return textResult(
          `Wrote 1 record to session ${input.sessionId} channel "${input.channel}" .in. This does not wake or trigger a run.`
        );
      },
    }),
  ];
}

export const sessionsWriteTools = createSessionsWriteTools();
