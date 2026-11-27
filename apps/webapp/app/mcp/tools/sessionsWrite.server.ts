import { tryCatch } from "@trigger.dev/core/utils";
import type { Session } from "@trigger.dev/database";
import { nanoid } from "nanoid";
import { prisma } from "~/db.server";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { S2RealtimeStreams } from "~/services/realtime/s2realtimeStreams.server";
import { SESSION_CHANNEL_NAME_REGEX } from "~/services/realtime/sessionChannels.server";
import {
  canonicalSessionAddressingKey,
  resolveSessionByIdOrExternalId,
  resolveSessionWithWriterFallback,
} from "~/services/realtime/sessions.server";
import { closeSession, sessionUpdateData } from "~/services/realtime/sessionWrites.server";
import { getRealtimeStreamInstance } from "~/services/realtime/v1StreamsGlobal.server";
import { ServiceValidationError } from "~/v3/services/common.server";
import { canonicalJson } from "../confirm/confirmation.server";
import type { McpPreviewRefusal, McpSubject } from "../gate/types";
import type { McpToolContext, McpToolResult } from "../gate/withMcpToolAuth.server";
import type { McpToolDefinition } from "../registry.server";
import { errorResult, resolveToolEnvironment, textResult } from "./define.server";
import { defineWriteTool, staleAnswer, staleApproval } from "./defineWrite.server";
import { plainError } from "./format/insights";
import { capText } from "./format/logFields";
import { renderSessionId } from "./format/sessions";
import { PREVIEW_UNSAFE, quoteForPreview } from "./format/webhooks";
import { startReadBudget } from "./readBudget.server";
import {
  CloseSessionInput,
  UpdateSessionInput,
  WriteSessionChannelInput,
} from "./schemas/sessions";

const auth = { action: "write", subject: "sessions" } as const;

const READ_BUDGET_MS = 10_000;
const SHOWN_CHARS = 16_000;
const STOPPED = {
  aborted: "The request was cancelled before the session was read; nothing changed.",
  timeout: "Reading the session took too long; nothing changed. Try again.",
};
const SESSION_CHANGED =
  "The session was changed by another request before this ran; nothing changed. Call the tool again.";

const CLOSED_UPDATE = "the session stays closed; only its tags and metadata change.";

const NOTIFIED = {
  true: " A close message was sent on the session's input; a run waiting on it stops when it handles the message.",
  false: " The close message could not be sent on the session's input.",
  undefined: "",
};

type Read = ReturnType<typeof startReadBudget>["read"];
type Plan<T> = { preview: string; value: T } | McpPreviewRefusal;
type Build<A, T> = (args: A, environmentId: string, read: Read) => Promise<Plan<T>>;

const sessionNotFound = (id: string) =>
  `Session ${renderSessionId(id)} not found in this environment; list_sessions lists the sessions in this environment. Nothing changed.`;

const revisionLine = (session: { updatedAt: Date }) =>
  `Session revision ${session.updatedAt.toISOString()}: if the session changes before this runs, it is refused.`;

const previewJson = (value: unknown) =>
  canonicalJson(value).replace(
    PREVIEW_UNSAFE,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`
  );

function shown(value: unknown) {
  if (value === null || value === undefined) return "none";
  return capText(previewJson(value), SHOWN_CHARS);
}

const shownTags = (tags: string[]) => (tags.length === 0 ? "none" : shown(tags));

async function findSession(
  environmentId: string,
  sessionId: string,
  read: Read
): Promise<{ session: Session } | McpPreviewRefusal> {
  const found = await read(() => resolveSessionByIdOrExternalId(prisma, environmentId, sessionId));
  if (!found.ok) return { refuse: STOPPED[found.reason] };
  if (!found.value) return { refuse: sessionNotFound(sessionId) };
  return { session: found.value };
}

const sessionLabel = (session: Session) =>
  `session ${session.friendlyId} of agent ${quoteForPreview(session.taskIdentifier)}`;

async function updatePlan(
  args: UpdateSessionInput,
  environmentId: string,
  read: Read
): Promise<Plan<Session>> {
  if (args.tags === undefined && args.metadata === undefined) {
    return { refuse: "No changes given: pass tags, metadata or both; nothing changed." };
  }
  if (args.metadata && previewJson(args.metadata).length > SHOWN_CHARS) {
    return {
      refuse: `This metadata is too large to show in full for approval (the limit is ${SHOWN_CHARS.toLocaleString("en-US")} characters). Send smaller metadata; nothing changed.`,
    };
  }
  const found = await findSession(environmentId, args.sessionId, read);
  if ("refuse" in found) return found;
  const { session } = found;

  const changes = [
    ...(args.tags !== undefined && canonicalJson(args.tags) !== canonicalJson(session.tags)
      ? [`- Tags: ${shownTags(session.tags)} → ${shownTags(args.tags)}`]
      : []),
    ...(args.metadata !== undefined &&
    canonicalJson(args.metadata) !== canonicalJson(session.metadata ?? null)
      ? [`- Metadata, replaced in full: ${shown(session.metadata)} → ${shown(args.metadata)}`]
      : []),
  ];
  if (changes.length === 0) {
    return {
      refuse: `Session ${session.friendlyId} already has these tags and metadata; nothing changed.`,
    };
  }

  const lines = [
    `Update ${sessionLabel(session)}:`,
    ...changes,
    ...(session.closedAt ? [`It is closed; ${CLOSED_UPDATE}`] : []),
    "Its external ID, status and runs do not change.",
    revisionLine(session),
  ];
  return { preview: lines.join("\n"), value: session };
}

async function closePlan(
  args: CloseSessionInput,
  environmentId: string,
  read: Read
): Promise<Plan<Session>> {
  const found = await findSession(environmentId, args.sessionId, read);
  if ("refuse" in found) return found;
  const { session } = found;
  if (session.closedAt) {
    return { refuse: `Session ${session.friendlyId} is already closed; nothing changed.` };
  }

  const lines = [
    `Close ${sessionLabel(session)} for good. A closed session can't be reopened: it accepts no more input and starts no more runs.`,
    session.currentRunId
      ? "A close message is sent on the session's input; a run waiting on it stops when it handles the message. This is best effort: the session is closed even if the message can't be sent."
      : "It has no current run, so no run is told.",
    `Reason: ${args.reason ? quoteForPreview(args.reason) : "none"}`,
    revisionLine(session),
  ];
  return { preview: lines.join("\n"), value: session };
}

function planPreview<A>(build: Build<A, unknown>) {
  return async (args: A, subject: McpSubject | null) => {
    if (!subject?.projectId || !subject.environmentId) return { refuse: "Environment not found" };
    // The gate gives a preview no request signal, so only the deadline can stop its reads.
    const { read } = startReadBudget(READ_BUDGET_MS, new AbortController().signal);
    const plan = await build(args, subject.environmentId, read);
    return "refuse" in plan ? plan : plan.preview;
  };
}

async function runPlan<A, T>(
  args: A,
  ctx: McpToolContext,
  build: Build<A, T>,
  act: (value: T, environment: AuthenticatedEnvironment) => Promise<McpToolResult>
) {
  const { read } = startReadBudget(READ_BUDGET_MS, ctx.signal);
  const found = await read(() => resolveToolEnvironment(ctx));
  if (!found.ok) return plainError(STOPPED[found.reason]);
  if (!found.value) return plainError("Environment not found");
  const plan = await build(args, found.value.id, read);
  if ("refuse" in plan) return plainError(plan.refuse);
  return staleApproval(ctx, plan.preview, plainError) ?? act(plan.value, found.value);
}

/** A write refused because the session changed: stale for an approved call, plain otherwise. */
const changedAnswer = (ctx: McpToolContext) =>
  ctx.confirmation ? staleAnswer(plainError) : plainError(SESSION_CHANGED);

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
    defineWriteTool({
      name: "update_session",
      title: "Update Session",
      description:
        "Replace a session's tags, its metadata, or both, like the public API's session update. Omitted fields keep their values; pass metadata null to clear it. This also works on a closed session. The external ID can't be changed.",
      shape: UpdateSessionInput.shape,
      approval: "configurable",
      auth,
      confirm: { preview: planPreview(updatePlan) },
      run: (input, ctx) =>
        runPlan(input, ctx, updatePlan, async (session) => {
          const { count } = await prisma.session.updateMany({
            where: { id: session.id, updatedAt: session.updatedAt },
            data: sessionUpdateData({ tags: input.tags, metadata: input.metadata }),
          });
          if (count === 0) return changedAnswer(ctx);
          return textResult(
            `Updated session ${session.friendlyId}.${session.closedAt ? ` ${CLOSED_UPDATE}` : ""}`
          );
        }),
    }),
    defineWriteTool({
      name: "close_session",
      title: "Close Session",
      description:
        "Close a session for good, like the public API's session close. It accepts no more input and starts no more runs, and its current run is asked to stop (best effort). Optionally record a reason.",
      shape: CloseSessionInput.shape,
      approval: "configurable",
      auth,
      confirm: { preview: planPreview(closePlan) },
      run: (input, ctx) =>
        runPlan(input, ctx, closePlan, async (session, environment) => {
          const { closed, notified } = await closeSession({
            session,
            environment,
            paramSession: input.sessionId,
            reason: input.reason,
            revision: session.updatedAt,
          });
          if (!closed) return changedAnswer(ctx);
          return textResult(
            `Closed session ${session.friendlyId}.${NOTIFIED[String(notified) as keyof typeof NOTIFIED]}`
          );
        }),
    }),
  ];
}

export const sessionsWriteTools = createSessionsWriteTools();
